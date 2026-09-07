import OpenAI from "openai";
import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
  ModelRetryGuard,
} from "./provider.js";

export class OpenAIProvider implements StreamingProvider {
  readonly name = "openai" as const;
  private client: OpenAI;
  constructor(
    apiKey: string,
    readonly model: string,
    private options: {
      timeoutMs?: number;
      maxOutputTokens?: number;
      fetch?: typeof fetch;
    } = {},
  ) {
    this.client = new OpenAI({
      apiKey,
      // Keep direct OpenAI independent of any ambient OPENAI_BASE_URL.
      baseURL: "https://api.openai.com/v1",
      timeout: options.timeoutMs ?? 60000,
      maxRetries: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  async *stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
    retryGuard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent> {
    signal.throwIfAborted();
    const denied = new AbortController();
    const guardedSignal = AbortSignal.any([signal, denied.signal]);
    let attempts = 0;
    // Per-stream client options isolate accounting across concurrent requests.
    // Keep the SDK's one bounded retry, but authorize it before transport I/O.
    const client = this.client.withOptions({
      fetch: async (url, init) => {
        guardedSignal.throwIfAborted();
        init?.signal?.throwIfAborted();
        if (attempts++ > 0) {
          try {
            await retryGuard?.beforeRetry();
          } catch (error) {
            // A denied guard is not a transient transport failure for the SDK.
            denied.abort();
            throw error;
          }
        }
        guardedSignal.throwIfAborted();
        init?.signal?.throwIfAborted();
        // A redirect must not create an unaccounted transport/recipient hop.
        return (this.options.fetch ?? fetch)(url, {
          ...init,
          redirect: "error",
        });
      },
    });
    const stream = await client.responses.create(
      {
        model: this.model,
        instructions,
        input: messages,
        stream: true,
        store: false,
        max_output_tokens: this.options.maxOutputTokens ?? 1400,
      },
      { signal: guardedSignal },
    );
    let completion: Extract<ModelStreamEvent, { type: "complete" }> | undefined;
    for await (const event of stream) {
      signal.throwIfAborted();
      if (completion) throw new Error("Provider sent events after completion");
      if (event.type === "response.output_text.delta")
        yield { type: "delta", text: event.delta };
      if (event.type === "response.completed") {
        if (!event.response.model?.trim())
          throw new Error("Provider omitted model");
        completion = {
          type: "complete",
          model: event.response.model,
          ...(event.response.usage
            ? {
                usage: {
                  inputTokens: event.response.usage.input_tokens,
                  outputTokens: event.response.usage.output_tokens,
                },
              }
            : {}),
        };
      }
      if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        event.type === "error"
      )
        throw new Error("Provider did not complete the response");
    }
    signal.throwIfAborted();
    if (!completion) throw new Error("Provider stream interrupted");
    yield completion;
  }
}

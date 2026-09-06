import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
} from "./provider.js";
import { readChatCompletion } from "./chat-completion.js";

type RouterAIOptions = {
  upstream: string;
  country?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  fetch?: typeof fetch;
};

export class RouterAIProvider implements StreamingProvider {
  readonly name = "routerai" as const;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly options: RouterAIOptions,
  ) {
    if (!apiKey.trim()) throw new Error("RouterAI requires ROUTERAI_API_KEY");
    // Do not allow model-embedded routing overrides (@ syntax) or URL inputs.
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.:-]+$/.test(model) || model.length > 200)
      throw new Error(
        "ROUTERAI_MODEL must be an author/model ID without routing overrides",
      );
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(options.upstream))
      throw new Error("ROUTERAI_UPSTREAM must be one lowercase provider tag");
    if (options.country !== undefined && !/^[a-z]{2}$/.test(options.country))
      throw new Error("ROUTERAI_COUNTRY must be a lowercase two-letter code");
  }

  async *stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 60000),
    ]);
    try {
      deadline.throwIfAborted();
      // One attempt, one fixed HTTPS recipient, no redirects or ambient base URL.
      const response = await (this.options.fetch ?? fetch)(
        "https://routerai.ru/api/v1/chat/completions",
        {
          method: "POST",
          redirect: "error",
          signal: deadline,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "system", content: instructions }, ...messages],
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: this.options.maxOutputTokens ?? 1400,
            provider: {
              only: [this.options.upstream],
              allow_fallbacks: false,
              ...(this.options.country
                ? { country: this.options.country }
                : {}),
            },
          }),
        },
      );
      if (
        !response.ok ||
        !response.body ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "text/event-stream"
      ) {
        await response.body?.cancel();
        throw new Error("Invalid RouterAI HTTP response");
      }
      yield* readChatCompletion(response.body, deadline);
    } catch {
      // Do not leak provider error bodies, credentials, prompts or network URLs.
      throw new Error("RouterAI generation failed or was interrupted");
    }
  }
}

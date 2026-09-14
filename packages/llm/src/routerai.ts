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
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
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
    if (
      options.reasoningEffort !== undefined &&
      !["low", "medium", "high", "xhigh", "max"].includes(
        options.reasoningEffort,
      )
    )
      throw new Error("ROUTERAI_REASONING_EFFORT is not supported");
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
            // Astra uses the native Chat Completions total-output cap, including
            // reasoning. Keep the historical payload for other configured models.
            ...(this.model === "openai/gpt-6-astra"
              ? { max_completion_tokens: this.options.maxOutputTokens ?? 1400 }
              : { max_tokens: this.options.maxOutputTokens ?? 1400 }),
            ...(this.options.reasoningEffort
              ? this.model === "openai/gpt-6-astra"
                ? { reasoning_effort: this.options.reasoningEffort }
                : { reasoning: { effort: this.options.reasoningEffort } }
              : {}),
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
      yield* readChatCompletion(
        response.body,
        deadline,
        this.model === "openai/gpt-6-astra"
          ? { maxOutputCharacters: 128000, maxStreamBytes: 16 * 1024 * 1024 }
          : undefined,
      );
    } catch {
      // Do not leak provider error bodies, credentials, prompts or network URLs.
      throw new Error("RouterAI generation failed or was interrupted");
    }
  }
}

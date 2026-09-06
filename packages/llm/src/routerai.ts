import type { ModelUsage } from "@citygo/contracts";
import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
} from "./provider.js";
import { readSseData } from "./sse.js";

type RouterAIOptions = {
  upstream: string;
  country?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  fetch?: typeof fetch;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid RouterAI stream object");
  return value as Record<string, unknown>;
}

function readUsage(value: unknown): ModelUsage {
  const usage = record(value);
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0
  )
    throw new Error("Invalid RouterAI usage");
  return { inputTokens: input, outputTokens: output };
}

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
      let stopped = false;
      let model: string | undefined;
      let usage: ModelUsage | undefined;
      let characters = 0;
      let hasText = false;
      for await (const data of readSseData(response.body, deadline)) {
        deadline.throwIfAborted();
        if (data === "[DONE]") {
          if (!stopped || !model || !hasText)
            throw new Error("Incomplete RouterAI response");
          yield { type: "complete", model, ...(usage ? { usage } : {}) };
          return;
        }
        const chunk = record(JSON.parse(data) as unknown);
        if (chunk.error != null) throw new Error("RouterAI stream error");
        if (chunk.model != null) {
          if (
            typeof chunk.model !== "string" ||
            !chunk.model.trim() ||
            chunk.model.length > 200 ||
            (model !== undefined && model !== chunk.model)
          )
            throw new Error("Invalid RouterAI model");
          model = chunk.model;
        }
        if (chunk.usage != null) usage = readUsage(chunk.usage);
        if (!Array.isArray(chunk.choices))
          throw new Error("Missing RouterAI choices");
        if (!chunk.choices.length) {
          // The optional usage-only chunk normally follows finish_reason.
          if (!stopped || chunk.usage == null)
            throw new Error("Unexpected RouterAI usage chunk");
          continue;
        }
        if (stopped || chunk.choices.length !== 1)
          throw new Error("Unexpected RouterAI choice");
        const choice = record(chunk.choices[0]);
        const delta = record(choice.delta);
        if (
          choice.index !== 0 ||
          choice.error != null ||
          delta.tool_calls != null ||
          delta.function_call != null ||
          (delta.refusal != null && delta.refusal !== "")
        )
          throw new Error("Unsupported RouterAI output");
        if (choice.finish_reason != null && choice.finish_reason !== "stop")
          throw new Error("RouterAI response did not finish successfully");
        if (delta.content != null) {
          if (typeof delta.content !== "string")
            throw new Error("Invalid RouterAI text");
          characters += delta.content.length;
          if (characters > 24000) throw new Error("RouterAI output too long");
          hasText ||= Boolean(delta.content.trim());
          if (delta.content) yield { type: "delta", text: delta.content };
        }
        // Reasoning fields are intentionally not exposed as answer text.
        stopped = choice.finish_reason === "stop";
      }
      throw new Error("RouterAI stream ended without DONE");
    } catch {
      // Do not leak provider error bodies, credentials, prompts or network URLs.
      throw new Error("RouterAI generation failed or was interrupted");
    }
  }
}

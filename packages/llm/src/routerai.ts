import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
  ModelRetryGuard,
} from "./provider.js";
import { readChatCompletion } from "./chat-completion.js";
import {
  creditGenerationIdSchema,
  routerAiChargeSchema,
  routerAiCostMicros,
  type RouterAiCharge,
} from "@citygo/contracts";

type RouterAIOptions = {
  upstream: string;
  country?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  fetch?: typeof fetch;
};

// Fixed-recipient HTTP 402, not a text/body heuristic and not proof of a zero
// bill. Callers must preserve monetary holds until independent reconciliation.
export class RouterAIInsufficientFundsError extends Error {
  readonly code = "PROVIDER_BALANCE_EXHAUSTED";
  constructor() {
    super("RouterAI generation failed or was interrupted");
    this.name = "RouterAIInsufficientFundsError";
  }
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
    guard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent> {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 60000),
    ]);
    try {
      deadline.throwIfAborted();
      let generationId: string | undefined;
      const recordGeneration = async (value: unknown) => {
        const id = creditGenerationIdSchema.parse(value);
        if (generationId && generationId !== id)
          throw new Error("Generation identity changed");
        if (!generationId) {
          await guard?.billing?.onGeneration(id);
          generationId = id;
        }
      };
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
            ...(guard?.billing ? { session_id: guard.billing.reference } : {}),
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
        response.redirected ||
        (response.url &&
          response.url !== "https://routerai.ru/api/v1/chat/completions")
      ) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Invalid RouterAI response recipient");
      }
      if (response.status === 402) {
        await response.body?.cancel().catch(() => {});
        throw new RouterAIInsufficientFundsError();
      }
      // Save identity before consuming the stream so a disconnect is auditable.
      const headerId = response.headers.get("x-generation-id");
      if (guard?.billing && headerId) {
        try {
          await recordGeneration(headerId);
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          throw error;
        }
      }
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
        this.model === "openai/gpt-6-astra" ||
          this.model === "deepseek/deepseek-v4-pro-0813"
          ? {
              maxOutputCharacters: 128000,
              maxStreamBytes: 16 * 1024 * 1024,
              ...(guard?.billing ? { onGeneration: recordGeneration } : {}),
            }
          : guard?.billing
            ? { onGeneration: recordGeneration }
            : undefined,
      );
    } catch (error) {
      // Do not leak provider error bodies, credentials, prompts or network URLs.
      if (error instanceof RouterAIInsufficientFundsError) throw error;
      throw new Error("RouterAI generation failed or was interrupted");
    }
  }

  async readCharge(
    generationId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<RouterAiCharge> {
    try {
      creditGenerationIdSchema.parse(generationId);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      deadline.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(
        `https://routerai.ru/api/v1/generation?id=${encodeURIComponent(generationId)}`,
        {
          method: "GET",
          redirect: "error",
          signal: deadline,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
          },
        },
      );
      if (
        !response.ok ||
        !response.body ||
        response.headers.get("content-type")?.split(";")[0]?.trim() !==
          "application/json"
      ) {
        await response.body?.cancel();
        throw new Error("Invalid cost response");
      }
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      deadline.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          deadline.throwIfAborted();
          const part = await reader.read();
          deadline.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 65536) throw new Error("Cost response too large");
          chunks.push(part.value);
        }
      } finally {
        deadline.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      // Node >=22.13 exposes the exact JSON number lexeme, before binary rounding.
      const data = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
        (key: string, value: unknown, context?: { source?: string }) => {
          if (key !== "total_cost") return value;
          if (typeof value !== "number" || !context?.source)
            throw new Error("Invalid cost");
          return context.source;
        },
      );
      if (
        data.id !== generationId ||
        data.session_id !== reference ||
        data.model !== this.model ||
        data.provider !== this.options.upstream ||
        data.api !== "chat/completions" ||
        data.source !== "api" ||
        data.has_web_search !== false
      )
        throw new Error("Cost identity mismatch");
      return routerAiChargeSchema.parse({
        generationId,
        reference,
        model: data.model,
        upstream: data.provider,
        currency: "RUB",
        costRub: data.total_cost,
        amountMicros: routerAiCostMicros(data.total_cost),
      });
    } catch {
      throw new Error("RouterAI cost could not be confirmed");
    }
  }
}

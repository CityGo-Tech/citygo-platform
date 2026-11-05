import type {
  ModelMessage,
  ModelStreamEvent,
  StreamingProvider,
  ModelRetryGuard,
} from "./provider.js";
import { readChatCompletion } from "./chat-completion.js";
import { readResponse } from "./responses.js";
import { readNativeWebResponse } from "./routerai-native-web.js";
import {
  creditGenerationIdSchema,
  routerAiChargeSchema,
  routerAiCostMicros,
  type RouterAiCharge,
} from "@citygo/contracts";

type RouterAIOptions = {
  protocol?: "responses";
  upstream: string;
  country?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  webSearch?: { engine: "native"; maxResults: 5 };
  // Explicit injected-transport test policy, never inferred from a response.
  nativeWebReceiptPolicy?: "routerai-native-total-cost-postpay-test-v1";
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
  private readonly protocol: "responses" | undefined;
  private readonly nativeWebReceiptPolicy?: "routerai-native-total-cost-postpay-test-v1";
  private readonly nativeWebOptions:
    | Readonly<
        Pick<
          RouterAIOptions,
          "fetch" | "timeoutMs" | "maxOutputTokens" | "reasoningEffort"
        >
      >
    | undefined;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly options: RouterAIOptions,
  ) {
    if (options.protocol !== undefined && options.protocol !== "responses")
      throw new Error("Unsupported RouterAI protocol");
    this.protocol = options.protocol;
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
    if (options.webSearch !== undefined) {
      const search: unknown = options.webSearch;
      if (
        !search ||
        typeof search !== "object" ||
        Array.isArray(search) ||
        Object.keys(search).length !== 2 ||
        options.webSearch.engine !== "native" ||
        options.webSearch.maxResults !== 5 ||
        model !== "openai/gpt-6.1-sol" ||
        options.upstream !== "openai" ||
        options.country !== "us" ||
        options.protocol !== undefined ||
        (options.maxOutputTokens !== undefined &&
          (!Number.isSafeInteger(options.maxOutputTokens) ||
            options.maxOutputTokens < 1 ||
            options.maxOutputTokens > 32768)) ||
        (options.timeoutMs !== undefined &&
          (!Number.isSafeInteger(options.timeoutMs) ||
            options.timeoutMs < 1 ||
            options.timeoutMs > 240000))
      )
        throw new Error("Unsupported RouterAI native search profile");
      // Pin the candidate at construction. Mutating the caller's options object
      // cannot change its model, endpoint, routing, plugin or receipt policy.
      this.nativeWebOptions = Object.freeze({
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        maxOutputTokens: options.maxOutputTokens,
        reasoningEffort: options.reasoningEffort,
      });
    }
    if (options.nativeWebReceiptPolicy !== undefined) {
      if (
        options.nativeWebReceiptPolicy !==
          "routerai-native-total-cost-postpay-test-v1" ||
        !this.nativeWebOptions ||
        typeof this.nativeWebOptions.fetch !== "function"
      )
        throw new Error(
          "Native postpay tests require explicit injected transport",
        );
      this.nativeWebReceiptPolicy = options.nativeWebReceiptPolicy;
    }
  }

  async *stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
    guard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent> {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(
        this.nativeWebOptions
          ? (this.nativeWebOptions.timeoutMs ?? 60000)
          : (this.options.timeoutMs ?? 60000),
      ),
    ]);
    try {
      deadline.throwIfAborted();
      if (this.nativeWebOptions) {
        yield* this.nativeWebStream(instructions, messages, deadline, guard);
        return;
      }
      const responses = this.protocol === "responses";
      const recipient = responses
        ? "https://routerai.ru/api/v1/responses"
        : "https://routerai.ru/api/v1/chat/completions";
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
      const response = await (this.options.fetch ?? fetch)(recipient, {
        method: "POST",
        redirect: "error",
        signal: deadline,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(
          responses
            ? {
                model: this.model,
                instructions,
                input: messages.map((message) => ({
                  role: message.role,
                  content: message.content,
                })),
                store: false,
                stream: true,
                max_output_tokens: this.options.maxOutputTokens ?? 1400,
                ...(this.options.reasoningEffort
                  ? { reasoning: { effort: this.options.reasoningEffort } }
                  : {}),
                ...(guard?.billing
                  ? { session_id: guard.billing.reference }
                  : {}),
                provider: {
                  only: [this.options.upstream],
                  allow_fallbacks: false,
                  ...(this.options.country
                    ? { country: this.options.country }
                    : {}),
                },
              }
            : {
                model: this.model,
                messages: [
                  { role: "system", content: instructions },
                  ...messages,
                ],
                stream: true,
                stream_options: { include_usage: true },
                ...(guard?.billing
                  ? { session_id: guard.billing.reference }
                  : {}),
                // Astra uses the native Chat Completions total-output cap, including
                // reasoning. Keep the historical payload for other configured models.
                ...(this.model === "openai/gpt-6-astra"
                  ? {
                      max_completion_tokens:
                        this.options.maxOutputTokens ?? 1400,
                    }
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
              },
        ),
      });
      if (response.redirected || (response.url && response.url !== recipient)) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Invalid RouterAI response recipient");
      }
      if (response.status === 402) {
        await response.body?.cancel().catch(() => {});
        throw new RouterAIInsufficientFundsError();
      }
      // Save identity before consuming the stream so a disconnect is auditable.
      const headerId = response.headers.get("x-generation-id");
      if (headerId && (guard?.billing || responses)) {
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
      if (responses) {
        yield* readResponse(response.body, deadline, {
          expectedModel: this.model,
          ...(this.model === "openai/gpt-6.1-sol"
            ? { expectedWireModel: "gpt-6.1-sol" }
            : {}),
          maxOutputCharacters: 128000,
          maxStreamBytes: 16 * 1024 * 1024,
          onGeneration: recordGeneration,
        });
        return;
      }
      yield* readChatCompletion(
        response.body,
        deadline,
        this.model === "openai/gpt-6-astra" ||
          this.model === "deepseek/deepseek-v4-pro-0813"
          ? {
              maxOutputCharacters: 128000,
              maxStreamBytes: 16 * 1024 * 1024,
              ...(this.model === "deepseek/deepseek-v4-pro-0813"
                ? { expectedModel: this.model }
                : {}),
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

  private async *nativeWebStream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
    guard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent> {
    const options = this.nativeWebOptions!;
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs ?? 60000),
    ]);
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
    const recipient = "https://routerai.ru/api/v1/chat/completions";
    const response = await (options.fetch ?? fetch)(recipient, {
      method: "POST",
      redirect: "error",
      signal: deadline,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-6.1-sol",
        messages: [
          { role: "system", content: instructions },
          ...messages.map(({ role, content }) => ({ role, content })),
        ],
        stream: false,
        max_tokens: options.maxOutputTokens ?? 1400,
        ...(options.reasoningEffort
          ? { reasoning: { effort: options.reasoningEffort } }
          : {}),
        ...(guard?.billing ? { session_id: guard.billing.reference } : {}),
        plugins: [{ id: "web", engine: "native", max_results: 5 }],
        provider: { only: ["openai"], allow_fallbacks: false, country: "us" },
      }),
    });
    try {
      if (response.redirected || (response.url && response.url !== recipient))
        throw new Error("Invalid RouterAI response recipient");
      const headerId = response.headers.get("x-generation-id");
      if (headerId) await recordGeneration(headerId);
      if (response.status === 402) throw new RouterAIInsufficientFundsError();
      if (
        !response.ok ||
        !response.body ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new Error("Invalid RouterAI native search HTTP response");
      const result = await readNativeWebResponse(
        response.body,
        deadline,
        recordGeneration,
      );
      deadline.throwIfAborted();
      yield { type: "delta", text: result.text };
      deadline.throwIfAborted();
      yield {
        type: "complete",
        model: "openai/gpt-6.1-sol",
        ...(result.usage ? { usage: result.usage } : {}),
        webSources: result.webSources,
      };
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }

  async readCharge(
    generationId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<RouterAiCharge> {
    // The original unbillable candidate remains closed before GET. A separate
    // injected-transport test profile can read the provider's whole total_cost;
    // it never derives a tool fee from tokens, links or a public price list.
    const nativeReceipt =
      this.nativeWebReceiptPolicy ===
      "routerai-native-total-cost-postpay-test-v1";
    if (this.nativeWebOptions && !nativeReceipt)
      throw new Error("RouterAI cost could not be confirmed");
    try {
      creditGenerationIdSchema.parse(generationId);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      deadline.throwIfAborted();
      const url = `https://routerai.ru/api/v1/generation?id=${encodeURIComponent(generationId)}`;
      const transport = nativeReceipt
        ? this.nativeWebOptions!.fetch!
        : (this.options.fetch ?? fetch);
      const response = await transport(url, {
        method: "GET",
        redirect: "error",
        signal: deadline,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });
      if (
        !response.ok ||
        (nativeReceipt &&
          (response.status !== 200 ||
            response.redirected ||
            (response.url !== "" && response.url !== url))) ||
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
      const envelope: unknown = JSON.parse(
        nativeReceipt
          ? new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            )
          : Buffer.concat(chunks).toString("utf8"),
        (key: string, value: unknown, context?: { source?: string }) => {
          if (key !== "total_cost") return value;
          if (typeof value !== "number" || !context?.source)
            throw new Error("Invalid cost");
          return context.source;
        },
      );
      // The generation lookup returns { data: receipt }, not a completion or a
      // flat receipt. Never fall back to unrelated outer fields on malformed
      // responses; identity and exact decimal checks below apply to this data.
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        Object.keys(envelope).length !== 1 ||
        !("data" in envelope) ||
        !envelope.data ||
        typeof envelope.data !== "object" ||
        Array.isArray(envelope.data)
      )
        throw new Error("Invalid cost envelope");
      const data = envelope.data as Record<string, unknown>;
      if (
        typeof data.total_cost !== "string" ||
        data.id !== generationId ||
        data.session_id !== reference ||
        data.model !== (nativeReceipt ? "openai/gpt-6.1-sol" : this.model) ||
        data.provider !== (nativeReceipt ? "openai" : this.options.upstream) ||
        data.api !==
          (nativeReceipt
            ? "chat/completions"
            : this.protocol === "responses"
              ? "responses"
              : "chat/completions") ||
        data.source !== "api" ||
        data.has_web_search !== nativeReceipt ||
        (nativeReceipt &&
          Object.hasOwn(data, "currency") &&
          data.currency !== "RUB")
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

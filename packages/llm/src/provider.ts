import type {
  AiProviderId,
  ModelUsage,
  RouterAiCharge,
} from "@citygo/contracts";

export type ModelMessage = { role: "user" | "assistant"; content: string };
// Counts of the supplied plain-text strings, aligned with the request. These
// exclude provider framing, tools, files and output; the caller budgets those.
export type ModelInputTokenCounts = {
  instructions: number;
  messages: number[];
};
export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; model: string; usage?: ModelUsage };

// The caller reserves the first model attempt before entering stream(). Every
// additional model HTTP attempt must await this guard before sending data.
export type ModelRetryGuard = {
  beforeRetry: () => Promise<void>;
  billing?: { reference: string; onGeneration: (id: string) => Promise<void> };
};

export interface StreamingProvider {
  readonly name: AiProviderId;
  readonly model: string;
  // Optional authenticated preflight for an explicitly sent request. A context
  // preview must remain offline; this method never generates a model answer.
  countInputTokens?(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
  ): Promise<ModelInputTokenCounts>;
  readCharge?(
    generationId: string,
    reference: string,
    signal: AbortSignal,
  ): Promise<RouterAiCharge>;
  stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
    retryGuard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent>;
}

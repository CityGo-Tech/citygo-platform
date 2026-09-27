import type {
  AiProviderId,
  ModelUsage,
  RouterAiCharge,
} from "@citygo/contracts";

export type ModelMessage = { role: "user" | "assistant"; content: string };
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

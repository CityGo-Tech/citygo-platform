import type { AiProviderId, ModelUsage } from "@citygo/contracts";

export type ModelMessage = { role: "user" | "assistant"; content: string };
export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; model: string; usage?: ModelUsage };

// The caller reserves the first model attempt before entering stream(). Every
// additional model HTTP attempt must await this guard before sending data.
export type ModelRetryGuard = { beforeRetry: () => Promise<void> };

export interface StreamingProvider {
  readonly name: AiProviderId;
  readonly model: string;
  stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
    retryGuard?: ModelRetryGuard,
  ): AsyncIterable<ModelStreamEvent>;
}

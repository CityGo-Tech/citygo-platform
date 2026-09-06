import type { AiProviderId, ModelUsage } from "@citygo/contracts";

export type ModelMessage = { role: "user" | "assistant"; content: string };
export type ModelStreamEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; model: string; usage?: ModelUsage };

export interface StreamingProvider {
  readonly name: AiProviderId;
  readonly model: string;
  stream(
    instructions: string,
    messages: ModelMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>;
}

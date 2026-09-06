export * from "./stream.js";
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: readonly LlmMessage[];
  responseSchemaName: string;
  traceId: string;
}

export interface LlmResponse {
  content: unknown;
  inputTokens?: number;
  outputTokens?: number;
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

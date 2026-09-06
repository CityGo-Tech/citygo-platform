import type { ModelUsage } from "@citygo/contracts";
import type { ModelStreamEvent } from "./provider.js";
import { readSseData } from "./sse.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Chat Completions stream object");
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
    throw new Error("Invalid Chat Completions usage");
  return { inputTokens: input, outputTokens: output };
}

export async function* readChatCompletion(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  let stopped = false;
  let model: string | undefined;
  let usage: ModelUsage | undefined;
  let characters = 0;
  let hasText = false;
  for await (const data of readSseData(body, signal)) {
    signal.throwIfAborted();
    if (data === "[DONE]") {
      if (!stopped || !model || !hasText)
        throw new Error("Incomplete Chat Completions response");
      yield { type: "complete", model, ...(usage ? { usage } : {}) };
      return;
    }
    const chunk = record(JSON.parse(data) as unknown);
    if (chunk.error != null) throw new Error("Chat Completions stream error");
    if (chunk.model != null) {
      if (
        typeof chunk.model !== "string" ||
        !chunk.model.trim() ||
        chunk.model.length > 200 ||
        (model !== undefined && model !== chunk.model)
      )
        throw new Error("Invalid Chat Completions model");
      model = chunk.model;
    }
    if (chunk.usage != null) usage = readUsage(chunk.usage);
    if (!Array.isArray(chunk.choices))
      throw new Error("Missing Chat Completions choices");
    if (!chunk.choices.length) {
      // The optional usage-only chunk normally follows finish_reason.
      if (!stopped || chunk.usage == null)
        throw new Error("Unexpected Chat Completions usage chunk");
      continue;
    }
    if (stopped || chunk.choices.length !== 1)
      throw new Error("Unexpected Chat Completions choice");
    const choice = record(chunk.choices[0]);
    const delta = record(choice.delta);
    if (
      choice.index !== 0 ||
      choice.error != null ||
      delta.tool_calls != null ||
      delta.function_call != null ||
      (delta.refusal != null && delta.refusal !== "")
    )
      throw new Error("Unsupported Chat Completions output");
    if (choice.finish_reason != null && choice.finish_reason !== "stop")
      throw new Error("Chat Completions response did not finish successfully");
    if (delta.content != null) {
      if (typeof delta.content !== "string")
        throw new Error("Invalid Chat Completions text");
      characters += delta.content.length;
      if (characters > 24000)
        throw new Error("Chat Completions output too long");
      hasText ||= Boolean(delta.content.trim());
      if (delta.content) yield { type: "delta", text: delta.content };
    }
    // Reasoning fields are intentionally not exposed as answer text.
    stopped = choice.finish_reason === "stop";
  }
  throw new Error("Chat Completions stream ended without DONE");
}

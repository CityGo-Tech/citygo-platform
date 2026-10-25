import { creditGenerationIdSchema, type ModelUsage } from "@citygo/contracts";
import type { ModelStreamEvent } from "./provider.js";
import { readSseData } from "./sse.js";

const invalid = () => new Error("Invalid Responses stream");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
};
const index = (value: unknown) => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 127
  )
    throw invalid();
  return value as number;
};
const id = (value: unknown) => creditGenerationIdSchema.parse(value);
const usage = (value: unknown): ModelUsage => {
  const v = record(value),
    input = v.input_tokens,
    output = v.output_tokens;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    (v.total_tokens !== undefined &&
      (!Number.isSafeInteger(v.total_tokens) ||
        v.total_tokens !== input + output))
  )
    throw invalid();
  return { inputTokens: input, outputTokens: output };
};
const reasoningEvents = new Set([
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
]);

// Text-only Responses SSE. The complete object must attest the exact streamed
// answer; neither a text.done event nor transport EOF means model completion.
// Reasoning is never returned as user-visible text. Tools/refusals fail closed.
export async function* readResponse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  limits: {
    expectedModel: string;
    onGeneration?: (id: unknown) => Promise<void>;
    maxOutputCharacters?: number;
    maxStreamBytes?: number;
  },
): AsyncIterable<ModelStreamEvent> {
  const maximum = limits.maxOutputCharacters ?? 24000;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 128000 ||
    typeof limits.expectedModel !== "string" ||
    !limits.expectedModel.trim() ||
    limits.expectedModel !== limits.expectedModel.trim() ||
    limits.expectedModel.length > 200
  )
    throw invalid();
  let responseId: string | undefined,
    model: string | undefined,
    sequence = -1,
    terminal: ModelUsage | undefined;
  let done = false,
    characters = 0;
  const declaredItems = new Map<number, { id: string; type: string }>();
  let message:
    | {
        id: string;
        index: number;
        parts: Map<number, string>;
        textDone: Set<number>;
        partDone: Set<number>;
        done: boolean;
      }
    | undefined;
  const bind = (event: Record<string, unknown>) => {
    if (!responseId || !model) throw invalid();
    const itemId = id(event.item_id),
      outputIndex = index(event.output_index);
    const declared = declaredItems.get(outputIndex);
    if (declared && (declared.type !== "message" || declared.id !== itemId))
      throw invalid();
    if (!message)
      message = {
        id: itemId,
        index: outputIndex,
        parts: new Map(),
        textDone: new Set(),
        partDone: new Set(),
        done: false,
      };
    if (message.id !== itemId || message.index !== outputIndex) throw invalid();
    return message;
  };
  const verifyMessage = (value: unknown, outputIndex: number) => {
    const item = record(value);
    if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      item.status !== "completed" ||
      !message ||
      id(item.id) !== message.id ||
      outputIndex !== message.index ||
      !Array.isArray(item.content) ||
      !item.content.length ||
      item.content.length > 128 ||
      item.content.length !== message.parts.size
    )
      throw invalid();
    let text = "";
    for (const [contentIndex, raw] of item.content.entries()) {
      const part = record(raw);
      if (
        part.type !== "output_text" ||
        typeof part.text !== "string" ||
        message.parts.get(contentIndex) !== part.text
      )
        throw invalid();
      text += part.text;
    }
    if (!text.trim() || text.length > maximum) throw invalid();
  };
  for await (const data of readSseData(body, signal, limits)) {
    signal.throwIfAborted();
    if (data === "[DONE]") {
      if (!terminal || done) throw invalid();
      done = true;
      continue;
    }
    if (terminal || done) throw invalid();
    const event = record(JSON.parse(data) as unknown);
    if (typeof event.type !== "string" || event.error != null) throw invalid();
    if (event.sequence_number !== undefined) {
      if (
        !Number.isSafeInteger(event.sequence_number) ||
        (event.sequence_number as number) <= sequence
      )
        throw invalid();
      sequence = event.sequence_number as number;
    }
    if (event.response_id !== undefined && event.response_id !== responseId)
      throw invalid();
    if (
      [
        "response.created",
        "response.in_progress",
        "response.completed",
        "response.failed",
        "response.incomplete",
      ].includes(event.type)
    ) {
      const response = record(event.response),
        nextId = id(response.id);
      // Preserve billing identity even if a later field rejects this attempt.
      await limits.onGeneration?.(nextId);
      if (responseId !== undefined && responseId !== nextId) throw invalid();
      responseId = nextId;
      if (
        response.model !== limits.expectedModel ||
        (model !== undefined && model !== response.model)
      )
        throw invalid();
      model = response.model as string;
      if (response.error != null || response.incomplete_details != null)
        throw invalid();
      if (event.type === "response.completed") {
        if (
          response.status !== "completed" ||
          !Array.isArray(response.output) ||
          !response.output.length ||
          response.output.length > 128
        )
          throw invalid();
        let answers = 0;
        for (const [outputIndex, raw] of response.output.entries()) {
          const item = record(raw);
          if (item.type === "reasoning") {
            if (id(item.id) === message?.id) throw invalid();
            continue;
          }
          verifyMessage(item, outputIndex);
          answers++;
        }
        if (answers !== 1 || !characters) throw invalid();
        terminal = usage(response.usage);
      } else if (
        event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        response.status !== "in_progress"
      )
        throw invalid();
      continue;
    }
    if (!responseId || !model) throw invalid();
    if (event.type === "error" || event.type.startsWith("response.refusal."))
      throw invalid();
    if (reasoningEvents.has(event.type)) continue;
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    ) {
      const item = record(event.item),
        outputIndex = index(event.output_index);
      const itemId = id(item.id),
        declared = declaredItems.get(outputIndex);
      if (declared && (declared.id !== itemId || declared.type !== item.type))
        throw invalid();
      if (event.type.endsWith(".added")) {
        if (declared) throw invalid();
        declaredItems.set(outputIndex, { id: itemId, type: String(item.type) });
      }
      if (item.type === "reasoning") {
        id(item.id);
        continue;
      }
      if (item.type !== "message" || item.role !== "assistant") throw invalid();
      const bound = bind({ item_id: item.id, output_index: outputIndex });
      if (event.type.endsWith(".done")) {
        if (bound.done) throw invalid();
        verifyMessage(item, outputIndex);
        bound.done = true;
      } else if (
        item.status !== "in_progress" ||
        !Array.isArray(item.content) ||
        item.content.length ||
        bound.parts.size
      )
        throw invalid();
      continue;
    }
    if (
      [
        "response.content_part.added",
        "response.content_part.done",
        "response.output_text.delta",
        "response.output_text.done",
        "response.output_text.annotation.added",
      ].includes(event.type)
    ) {
      const bound = bind(event),
        contentIndex = index(event.content_index);
      if (bound.done) throw invalid();
      if (event.type === "response.content_part.added") {
        const part = record(event.part);
        if (
          part.type !== "output_text" ||
          part.text !== "" ||
          bound.parts.has(contentIndex)
        )
          throw invalid();
        bound.parts.set(contentIndex, "");
      } else if (event.type === "response.output_text.delta") {
        if (
          typeof event.delta !== "string" ||
          bound.textDone.has(contentIndex) ||
          bound.partDone.has(contentIndex)
        )
          throw invalid();
        characters += event.delta.length;
        if (characters > maximum) throw invalid();
        bound.parts.set(
          contentIndex,
          (bound.parts.get(contentIndex) ?? "") + event.delta,
        );
        if (event.delta) yield { type: "delta", text: event.delta };
      } else if (event.type === "response.output_text.done") {
        if (
          bound.textDone.has(contentIndex) ||
          bound.partDone.has(contentIndex) ||
          typeof event.text !== "string" ||
          event.text !== bound.parts.get(contentIndex)
        )
          throw invalid();
        bound.textDone.add(contentIndex);
      } else if (event.type === "response.content_part.done") {
        const part = record(event.part);
        if (
          bound.partDone.has(contentIndex) ||
          part.type !== "output_text" ||
          part.text !== bound.parts.get(contentIndex)
        )
          throw invalid();
        bound.partDone.add(contentIndex);
      } else if (!bound.parts.has(contentIndex)) throw invalid();
      continue;
    }
    throw invalid();
  }
  signal.throwIfAborted();
  if (!terminal || !model)
    throw new Error("Responses stream ended without completed response");
  yield { type: "complete", model, usage: terminal };
}

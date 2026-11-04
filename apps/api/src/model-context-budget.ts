import { Buffer } from "node:buffer";
import type { AiModeId } from "@citygo/contracts";

/** Gateway capacities, not upload sizes. Output and framing share this window. */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<AiModeId, number>> = {
  maximum: 1_000_000,
  balanced: 1_000_000,
  minimum: 128_000,
};
export const MODEL_CONTEXT_FRAMING_RESERVE = 4096;
export const MODEL_CONTEXT_STRATEGY = "model_window_memory_v1" as const;

/**
 * An intentionally conservative text envelope, NOT an exact tokenizer.
 * No /4 character heuristic or unverified tokenizer/model mapping is used.
 * Normalization expansion is covered as well as the original UTF-8 form.
 */
export function conservativeTextTokens(text: string): number {
  return Math.max(
    Buffer.byteLength(text, "utf8"),
    Buffer.byteLength(text.normalize("NFKC"), "utf8"),
  );
}

export function modelContextBudget(mode: AiModeId, maxOutputTokens: number) {
  const contextWindowTokens = MODEL_CONTEXT_WINDOWS[mode];
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens + MODEL_CONTEXT_FRAMING_RESERVE >= contextWindowTokens
  )
    throw new Error("Invalid model context output allowance");
  return {
    version: MODEL_CONTEXT_STRATEGY,
    contextWindowTokens,
    maxInputTokens:
      contextWindowTokens - maxOutputTokens - MODEL_CONTEXT_FRAMING_RESERVE,
    maxOutputTokens,
    framingReserve: MODEL_CONTEXT_FRAMING_RESERVE,
    counter:
      mode === "minimum"
        ? ("gigachat_text_count_with_framing_v1" as const)
        : ("conservative_utf8_v1" as const),
    memory: "source_fragments_v1" as const,
    recentPairs: 100,
  };
}

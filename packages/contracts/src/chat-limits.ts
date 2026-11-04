import { z } from "zod";

/** Count Unicode code points, so a surrogate pair is one character. */
export const CHAT_MAX_CHARACTERS = 100_000;
export const CHAT_MAX_UTF16_UNITS = CHAT_MAX_CHARACTERS * 2;
export const CHAT_CHARACTER_LIMIT_LABEL = "100 000";

export function chatCharacterCount(value: string): number {
  let count = 0;
  for (let offset = 0; offset < value.length; count++)
    offset += value.codePointAt(offset)! > 0xffff ? 2 : 1;
  return count;
}

export function chatTextProblem(
  value: string,
): "too_long" | "invalid_unicode" | "invalid_character" | null {
  // Reject giant pasted bodies before scanning or allocating a second string.
  if (value.length > CHAT_MAX_UTF16_UNITS) return "too_long";
  let count = 0;
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code === 0) return "invalid_character";
    if (code >= 0xd800 && code <= 0xdfff) return "invalid_unicode";
    if (++count > CHAT_MAX_CHARACTERS) return "too_long";
  }
  return null;
}

export function chatTextError(value: string): string | null {
  const problem = chatTextProblem(value);
  return problem === "too_long"
    ? `В сообщении можно отправить до ${CHAT_CHARACTER_LIMIT_LABEL} символов. Разделите текст на несколько сообщений.`
    : problem === "invalid_unicode" || problem === "invalid_character"
      ? "В тексте есть повреждённый символ. Исправьте его перед отправкой."
      : null;
}

/** Drafts preserve whitespace; only an explicit send trims the outer spaces. */
export const chatTextSchema = z.string().superRefine((value, context) => {
  const message = chatTextError(value);
  if (message) context.addIssue({ code: "custom", message });
});
export const chatMessageTextSchema = chatTextSchema
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "Напишите сообщение помощнику.");

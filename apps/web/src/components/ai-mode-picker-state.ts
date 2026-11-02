import { aiModeIdSchema, type AiModeId, type AiModes } from "@citygo/contracts";

export const aiModeDescriptions: Readonly<Record<AiModeId, string>> = {
  maximum: "Сложные вопросы и подробный разбор вариантов.",
  balanced: "Повседневные вопросы и планирование переезда.",
  minimum: "Простые вопросы и первые шаги.",
};

/** Selection is a UI intent; required consent remains the parent's explicit flow. */
export function selectableAiMode(
  modes: AiModes | undefined,
  value: unknown,
  disabled: boolean,
): value is AiModeId {
  const mode = aiModeIdSchema.safeParse(value);
  return (
    !disabled &&
    mode.success &&
    !!modes?.options.some(
      (option) => option.id === mode.data && option.available,
    )
  );
}

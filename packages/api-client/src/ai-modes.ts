import {
  aiModesSchema,
  type AiModeId,
  type AiModeSelection,
  type AiModes,
} from "@citygo/contracts";

export const aiModeUnavailableMessage =
  "Режим сейчас недоступен. Обновите данные и выберите снова.";

export function formatAiModeOptionLabel(
  option: AiModes["options"][number],
): string {
  return option.price ? `${option.label} · 3 ₽ за запрос` : option.label;
}

export function isAiModeAvailable(
  modes: AiModes | undefined,
  selected: AiModeId,
  legacyAvailable: boolean,
): boolean {
  return modes === undefined
    ? legacyAvailable
    : modes.options.some(
        (option) =>
          option.id === selected && option.available && !option.consentRequired,
      );
}

/** Capture once at explicit submission. Never choose another mode or send a request. */
export function captureAiModeSelection(
  modes: AiModes | undefined,
  selected: AiModeId,
): AiModeSelection | undefined {
  if (modes === undefined) return undefined;
  const parsed = aiModesSchema.safeParse(modes);
  if (
    !parsed.success ||
    !parsed.data.options.some(
      (option) =>
        option.id === selected && option.available && !option.consentRequired,
    )
  )
    throw new Error(aiModeUnavailableMessage);
  return { aiMode: selected, aiModeCatalogId: parsed.data.catalogId };
}

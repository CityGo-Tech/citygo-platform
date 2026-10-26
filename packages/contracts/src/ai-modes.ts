import { z } from "zod";

// Public product choices. Provider identities and model routing remain server-owned.
export const aiModeIds = ["maximum", "balanced", "minimum"] as const;
export const aiModeIdSchema = z.enum(aiModeIds);
export type AiModeId = z.infer<typeof aiModeIdSchema>;
export const aiModeLabels: Readonly<Record<AiModeId, string>> = {
  maximum: "Максимум",
  balanced: "Баланс",
  minimum: "Минимум",
};
export const aiModeCatalogIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const aiModeSelectionSchema = z.strictObject({
  aiMode: aiModeIdSchema,
  aiModeCatalogId: aiModeCatalogIdSchema,
});
export type AiModeSelection = z.infer<typeof aiModeSelectionSchema>;
export const aiModeFixedPriceSchema = z.strictObject({
  kind: z.literal("fixed"),
  currency: z.literal("RUB"),
  amountMicros: z.literal(3_000_000),
});
export const aiModesSchema = z
  .strictObject({
    catalogId: aiModeCatalogIdSchema,
    defaultMode: z.literal("balanced"),
    options: z
      .array(
        z.strictObject({
          id: aiModeIdSchema,
          label: z.string().min(1).max(30),
          available: z.boolean(),
          consentRequired: z.boolean().optional(),
          price: aiModeFixedPriceSchema.optional(),
        }),
      )
      .length(3),
  })
  .refine(
    (value) =>
      new Set(value.options.map((option) => option.id)).size === 3 &&
      value.options.every(
        (option) =>
          option.label === aiModeLabels[option.id] &&
          (option.price === undefined || option.id === "minimum"),
      ),
    "Expected the three public CityGo modes",
  );
export type AiModes = z.infer<typeof aiModesSchema>;

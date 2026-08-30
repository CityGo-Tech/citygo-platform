import { z } from "zod";

export const relocationStages = [
  "profile",
  "housing",
  "work",
  "documents",
  "adaptation",
] as const;

export const relocationStageSchema = z.enum(relocationStages);

export const healthResponseSchema = z.object({
  service: z.literal("citygo-api"),
  status: z.literal("ok"),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RelocationStage = z.infer<typeof relocationStageSchema>;

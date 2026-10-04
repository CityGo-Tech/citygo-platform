import { z } from "zod";
export * from "./platform.js";
export * from "./llm.js";
export * from "./ai-access.js";
export * from "./ai-budget.js";
export * from "./ai-credit.js";
export * from "./responses.js";
export * from "./protocol.js";
export * from "./r1.js";
// Candidate DTOs only: Prepared/brands do not authorize confirmation or XP.
export * from "./housing.js";
export * from "./housing-api.js";

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

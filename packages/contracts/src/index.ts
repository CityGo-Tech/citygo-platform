import { z } from "zod";
export * from "./platform.js";
export * from "./email-registration.js";
export * from "./service-consents.js";
export * from "./password-recovery.js";
export * from "./phone-verification.js";
export * from "./message-favorites.js";
export * from "./personal-plan.js";
export * from "./personal-memory.js";
export * from "./conversation-history.js";
export * from "./llm.js";
export * from "./ai-access.js";
export * from "./ai-budget.js";
export * from "./ai-credit.js";
export * from "./citygo-tariff.js";
export * from "./payments.js";
export * from "./payment-admission.js";
export * from "./payment-refunds.js";
export * from "./payment-fiscal.js";
export * from "./yookassa-receipt.js";
// NPD provider choices for planning only, not runtime or fiscal approval.
export * from "./npd-receipt-plan.js";
export * from "./npd-receipts.js";
export * from "./responses.js";
export * from "./protocol.js";
export * from "./r1.js";
// Candidate DTOs only: Prepared/brands do not authorize confirmation or XP.
export * from "./housing.js";
export * from "./housing-api.js";
// Candidate permission commands; no production handler or approved R1 policy.
export * from "./r1-permissions.js";
// Test harness protocol only, never real consent or AI admission.
export * from "./r1-permission-synthetic.js";
// Offline public knowledge candidates and retrieval policy; no live research.
export * from "./knowledge.js";

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

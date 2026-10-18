import { z } from "zod";

// Offline planning choices only. This is not a runtime configuration, proof of
// tax status, authorization, or a record that a receipt was issued/delivered.
// Payment acceptance and receipt preparation are separate responsibilities.
// Future provider choices do not mean those integrations are implemented.
export const npdReceiptPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fiscalFramework: z.literal("npd"),
  paymentProvider: z.enum(["yookassa", "robokassa"]),
  receiptProvider: z.enum(["npd_manual", "npd_partner"]),
});
export type NpdReceiptPlan = z.infer<typeof npdReceiptPlanSchema>;

export class NpdReceiptPlanError extends Error {
  readonly code = "plan";

  constructor() {
    // No rejected values, unknown keys, Zod issues, credentials or PII.
    super("Invalid NPD receipt plan");
    this.name = "NpdReceiptPlanError";
  }
}

// Use this helper at operator-input boundaries instead of exposing schema
// validation errors. The normalized result contains the four public choices.
export function parseNpdReceiptPlan(input: unknown): NpdReceiptPlan {
  const result = npdReceiptPlanSchema.safeParse(input);
  if (!result.success) throw new NpdReceiptPlanError();
  return result.data;
}

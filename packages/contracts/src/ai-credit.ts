import { z } from "zod";
import { CITYGO_MAX_AMOUNT_MICROS } from "./citygo-tariff.js";

export const AI_WELCOME_CREDIT_MICROS = 500_000_000;
export const creditGenerationIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,200}$/);
// Exact decimal conversion; sub-microrouble fractions stay with the customer.
// No multiplication of a floating-point provider price and no FX conversion.
export function routerAiCostMicros(value: string): number {
  const match = /^(\d{1,13})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(
    value,
  );
  if (!match) throw new Error("Invalid RouterAI cost");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) + 6 - fraction.length;
  if (Math.abs(exponent) > 60) throw new Error("Invalid RouterAI cost");
  const digits = BigInt(match[1]! + fraction);
  const micros =
    exponent >= 0
      ? digits * 10n ** BigInt(exponent)
      : digits / 10n ** BigInt(-exponent);
  if (micros > 1_000_000_000_000n) throw new Error("Invalid RouterAI cost");
  return Number(micros);
}
export const routerAiChargeSchema = z
  .strictObject({
    generationId: creditGenerationIdSchema,
    reference: z.uuid(),
    model: z.string().min(1).max(200),
    upstream: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    currency: z.literal("RUB"),
    costRub: z.string().max(80),
    amountMicros: z.number().int().min(0).max(1_000_000_000_000),
  })
  .refine((v) => {
    try {
      return routerAiCostMicros(v.costRub) === v.amountMicros;
    } catch {
      return false;
    }
  });
export type RouterAiCharge = z.infer<typeof routerAiChargeSchema>;
export const aiCreditReconcileSchema = z.strictObject({
  userId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  holdId: z.uuid(),
  confirmReconcile: z.literal(true),
});
export type AiCreditReconcile = z.infer<typeof aiCreditReconcileSchema>;
const amount = z.number().int().min(0).max(CITYGO_MAX_AMOUNT_MICROS);
export const creditUserIdSchema = z.string().regex(/^[1-9][0-9]{0,17}$/);
export const aiCreditGrantSchema = z.strictObject({
  userId: creditUserIdSchema,
  confirmOneTime500Rub: z.literal(true),
});
export type AiCreditGrant = z.infer<typeof aiCreditGrantSchema>;
export const aiCreditResponseSchema = z
  .object({
    currency: z.literal("RUB"),
    bonusGranted: z.boolean(),
    grantedMicros: amount,
    heldMicros: amount,
    spentMicros: amount,
    availableMicros: amount,
    chargingStatus: z.enum([
      "not_connected",
      "routerai_at_cost",
      "routerai_citygo_10x",
    ]),
    // A server capability, not evidence that a return URL or payment succeeded.
    topUpAvailable: z.boolean(),
    pending: z
      .array(
        z.object({
          holdId: z.uuid(),
          amountMicros: amount,
          responseComplete: z.boolean(),
        }),
      )
      .max(20)
      .optional(),
    history: z
      .array(
        z.object({
          id: creditUserIdSchema,
          kind: z.enum(["bonus", "topup", "hold", "settle", "release"]),
          amountMicros: amount,
          createdAt: z.iso.datetime(),
        }),
      )
      .max(20),
  })
  .refine(
    (v) => v.availableMicros + v.heldMicros + v.spentMicros === v.grantedMicros,
  )
  .refine(
    (v) => !v.bonusGranted || v.grantedMicros >= AI_WELCOME_CREDIT_MICROS,
  );
export type AiCredit = z.infer<typeof aiCreditResponseSchema>;

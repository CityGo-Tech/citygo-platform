import { z } from "zod";

export const AI_WELCOME_CREDIT_MICROS = 500_000_000;
const amount = z.number().int().min(0).max(AI_WELCOME_CREDIT_MICROS);
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
    // Until trusted pricing/settlement is connected, do not market a payable wallet.
    chargingStatus: z.literal("not_connected"),
    topUpAvailable: z.literal(false),
    history: z
      .array(
        z.object({
          id: creditUserIdSchema,
          kind: z.enum(["bonus", "hold", "settle", "release"]),
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
    (v) => v.grantedMicros === (v.bonusGranted ? AI_WELCOME_CREDIT_MICROS : 0),
  );
export type AiCredit = z.infer<typeof aiCreditResponseSchema>;

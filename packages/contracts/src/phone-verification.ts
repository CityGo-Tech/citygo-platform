import { z } from "zod";
import {
  emailRegistrationChallengeSchema,
  emailRegistrationConfirmSchema,
  emailRegistrationResendSchema,
} from "./email-registration.js";

// Pilot is Russian MOBILE numbers only; +76/+77 are not silently accepted as RF.
export const russianMobilePhoneSchema = z
  .string()
  .max(32)
  .transform((raw, ctx) => {
    const compact = raw.trim().replace(/[ ()-]/g, "");
    const canonical = /^89[0-9]{9}$/.test(compact)
      ? "+7" + compact.slice(1)
      : /^79[0-9]{9}$/.test(compact)
        ? "+" + compact
        : compact;
    if (!/^\+79[0-9]{9}$/.test(canonical)) {
      ctx.addIssue({
        code: "custom",
        message: "Укажите российский мобильный номер +7 9XX XXX-XX-XX",
      });
      return z.NEVER;
    }
    return canonical;
  });
export const phoneVerificationPolicySchema = z
  .strictObject({
    phoneVerification: z.enum(["disabled", "unavailable", "required"]),
    // Bind UI disclosure/consent to the selected server-side recipient, even
    // while that provider is not yet available for actual SMS admissions.
    deliveryProvider: z.enum(["none", "sms_ru", "prosto_sms"]),
    giftAmountMicros: z.literal(500_000_000),
    // Account eligibility only: the entered number must still pass the
    // retained-phone claim check before any SMS admission or grant.
    giftStatus: z.enum([
      "unavailable",
      "email_required",
      "eligible",
      "granted",
    ]),
  })
  .refine(
    (value) =>
      (value.phoneVerification === "required") ===
      (value.giftStatus !== "unavailable"),
    "Состояние подарка не соответствует доступности подтверждения телефона",
  )
  .refine(
    (value) =>
      (value.phoneVerification === "disabled") ===
      (value.deliveryProvider === "none"),
    "Провайдер не соответствует режиму подтверждения телефона",
  );
export const phoneVerificationStartSchema = z.strictObject({
  phone: russianMobilePhoneSchema,
  expectedDeliveryProvider: z.enum(["sms_ru", "prosto_sms"]),
});
export const phoneVerificationResendSchema =
  emailRegistrationResendSchema.extend({
    phone: russianMobilePhoneSchema,
    expectedDeliveryProvider: z.enum(["sms_ru", "prosto_sms"]),
  });
export const phoneVerificationConfirmSchema =
  emailRegistrationConfirmSchema.extend({ phone: russianMobilePhoneSchema });
export const phoneVerificationChallengeSchema =
  emailRegistrationChallengeSchema;
export const phoneVerificationReceiptSchema = z.strictObject({
  operationId: z.uuid(),
  grantedMicros: z.literal(500_000_000),
  alreadyGranted: z.boolean(),
});
export type PhoneVerificationReceipt = z.infer<
  typeof phoneVerificationReceiptSchema
>;

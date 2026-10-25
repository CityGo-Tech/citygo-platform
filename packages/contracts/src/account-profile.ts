import { z } from "zod";
import { accountUserSchema } from "./platform.js";
import {
  emailRegistrationChallengeSchema,
  emailRegistrationConfirmSchema,
  emailRegistrationResendSchema,
} from "./email-registration.js";

// This is the signed-in account's contact state, not inferred AI memory.
export const accountProfileSchema = z
  .strictObject({
    userId: accountUserSchema.shape.id,
    email: z.email().max(254).nullable(),
    emailVerified: z.boolean(),
    phoneVerified: z.boolean(),
    giftStatus: z.enum(["available", "claimed", "unavailable"]),
    emailConfirmation: z.enum(["available", "unavailable"]),
  })
  .refine(
    (value) =>
      value.email !== null ||
      (!value.emailVerified && value.emailConfirmation === "unavailable"),
    { message: "Для подтверждения нужна почта аккаунта" },
  );

// No caller-supplied address or account id: identity comes from the session.
export const accountEmailVerificationStartSchema = z.strictObject({});
export const accountEmailVerificationChallengeSchema =
  emailRegistrationChallengeSchema;
export const accountEmailVerificationResendSchema =
  emailRegistrationResendSchema;
export const accountEmailVerificationConfirmSchema =
  emailRegistrationConfirmSchema;
export const accountEmailVerificationReceiptSchema = z.strictObject({
  userId: accountUserSchema.shape.id,
  emailVerified: z.literal(true),
});

export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type AccountEmailVerificationChallenge = z.infer<
  typeof accountEmailVerificationChallengeSchema
>;
export type AccountEmailVerificationResend = z.infer<
  typeof accountEmailVerificationResendSchema
>;
export type AccountEmailVerificationConfirm = z.infer<
  typeof accountEmailVerificationConfirmSchema
>;
export type AccountEmailVerificationReceipt = z.infer<
  typeof accountEmailVerificationReceiptSchema
>;

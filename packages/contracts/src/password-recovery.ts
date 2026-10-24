import { z } from "zod";
import { registrationCredentialsSchema } from "./platform.js";

export const passwordRecoveryPolicySchema = z.strictObject({
  passwordRecovery: z.enum(["available", "unavailable"]),
});
const capability = {
  challengeId: z.uuid(),
  proof: z.string().regex(/^[a-f0-9]{64}$/),
};
// These capabilities are ephemeral view state, never a session or persistent token.
export const passwordRecoveryRequestSchema = z.strictObject({
  email: registrationCredentialsSchema.shape.email,
});
export const passwordRecoveryChallengeSchema = z.strictObject({
  ...capability,
  expiresAt: z.iso.datetime({ offset: true }),
  resendAfterSeconds: z.number().int().min(0).max(600),
});
export const passwordRecoveryResendSchema = z.strictObject(capability);
export const passwordRecoveryConfirmSchema = z.strictObject({
  ...capability,
  code: z.string().regex(/^[0-9]{6}$/),
  newPassword: registrationCredentialsSchema.shape.password,
});
export const passwordRecoveryReceiptSchema = z.strictObject({
  passwordReset: z.literal(true),
  sessionsRevoked: z.literal(true),
});
export type PasswordRecoveryPolicy = z.infer<
  typeof passwordRecoveryPolicySchema
>;
export type PasswordRecoveryRequest = z.infer<
  typeof passwordRecoveryRequestSchema
>;
export type PasswordRecoveryChallenge = z.infer<
  typeof passwordRecoveryChallengeSchema
>;
export type PasswordRecoveryResend = z.infer<
  typeof passwordRecoveryResendSchema
>;
export type PasswordRecoveryConfirm = z.infer<
  typeof passwordRecoveryConfirmSchema
>;
export type PasswordRecoveryReceipt = z.infer<
  typeof passwordRecoveryReceiptSchema
>;

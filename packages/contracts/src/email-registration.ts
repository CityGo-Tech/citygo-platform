import { z } from "zod";

export const registrationPolicyResponseSchema = z.strictObject({
  emailVerification: z.enum(["disabled", "required", "unavailable"]),
});

// A challenge is a short-lived capability, not a session. Keep its proof only
// in the current registration view's memory; never persist it or expose an OTP.
const challengeIdSchema = z.uuid();
const challengeProofSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const emailRegistrationChallengeSchema = z.strictObject({
  challengeId: challengeIdSchema,
  proof: challengeProofSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  resendAfterSeconds: z.number().int().min(0).max(600),
});
export const emailRegistrationResendSchema = z.strictObject({
  challengeId: challengeIdSchema,
  proof: challengeProofSchema,
});
export const emailRegistrationConfirmSchema = z.strictObject({
  challengeId: challengeIdSchema,
  proof: challengeProofSchema,
  code: z.string().regex(/^[0-9]{6}$/),
});

export type RegistrationPolicyResponse = z.infer<
  typeof registrationPolicyResponseSchema
>;
export type EmailRegistrationChallenge = z.infer<
  typeof emailRegistrationChallengeSchema
>;
export type EmailRegistrationResend = z.infer<
  typeof emailRegistrationResendSchema
>;
export type EmailRegistrationConfirm = z.infer<
  typeof emailRegistrationConfirmSchema
>;

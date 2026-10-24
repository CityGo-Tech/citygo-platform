import assert from "node:assert/strict";
import test from "node:test";
import {
  passwordRecoveryPolicySchema,
  passwordRecoveryRequestSchema,
  passwordRecoveryChallengeSchema,
  passwordRecoveryResendSchema,
  passwordRecoveryConfirmSchema,
  passwordRecoveryReceiptSchema,
} from "./password-recovery.js";

const binding = {
  challengeId: "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  proof: "ab".repeat(32),
};
const challenge = {
  ...binding,
  expiresAt: "2099-01-01T12:00:00.000Z",
  resendAfterSeconds: 60,
};
test("recovery contracts expose only generic capabilities and a session-free receipt", () => {
  assert.deepEqual(
    passwordRecoveryRequestSchema.parse({ email: "SYNTHETIC@EXAMPLE.TEST" }),
    { email: "synthetic@example.test" },
  );
  assert.deepEqual(passwordRecoveryChallengeSchema.parse(challenge), challenge);
  assert.deepEqual(passwordRecoveryResendSchema.parse(binding), binding);
  for (const passwordRecovery of ["available", "unavailable"])
    assert.deepEqual(passwordRecoveryPolicySchema.parse({ passwordRecovery }), {
      passwordRecovery,
    });
  assert.deepEqual(
    passwordRecoveryReceiptSchema.parse({
      passwordReset: true,
      sessionsRevoked: true,
    }),
    { passwordReset: true, sessionsRevoked: true },
  );
  for (const extra of [
    { code: "123456" },
    { email: "synthetic@example.test" },
    { token: "session" },
    { user: {} },
    { delivery: "sent" },
  ]) {
    assert.equal(
      passwordRecoveryChallengeSchema.safeParse({ ...challenge, ...extra })
        .success,
      false,
    );
    assert.equal(
      passwordRecoveryReceiptSchema.safeParse({
        passwordReset: true,
        sessionsRevoked: true,
        ...extra,
      }).success,
      false,
    );
  }
});
test("recovery confirm keeps opaque passwords and strictly validates command capability", () => {
  const input = { ...binding, code: "012345", newPassword: "      " };
  assert.deepEqual(passwordRecoveryConfirmSchema.parse(input), input);
  for (const change of [
    { newPassword: "12345" },
    { newPassword: "x".repeat(129) },
    { code: "１２３４５６" },
    { code: 123456 },
    { code: "12345" },
    { proof: "AB".repeat(32) },
    { challengeId: "invalid" },
    { email: "extra@example.test" },
    { password: "extra" },
  ])
    assert.equal(
      passwordRecoveryConfirmSchema.safeParse({ ...input, ...change }).success,
      false,
    );
  for (const input of [
    {},
    { email: "invalid" },
    { email: "a@example.test", password: "extra" },
  ])
    assert.equal(passwordRecoveryRequestSchema.safeParse(input).success, false);
});

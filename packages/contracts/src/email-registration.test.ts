import assert from "node:assert/strict";
import test from "node:test";
import { serviceConsentPolicy } from "./service-consents.js";
import {
  emailRegistrationChallengeSchema,
  emailRegistrationConfirmSchema,
  emailRegistrationResendSchema,
  registrationPolicyResponseSchema,
} from "./email-registration.js";

const challenge = {
  challengeId: "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  proof: "ab".repeat(32),
  expiresAt: "2099-01-01T12:00:00.000Z",
  resendAfterSeconds: 60,
};
const capability = {
  challengeId: challenge.challengeId,
  proof: challenge.proof,
};

test("email registration policy is a strict explicit state, never a coerced flag", () => {
  for (const emailVerification of [
    "disabled",
    "required",
    "unavailable",
  ] as const)
    assert.deepEqual(
      registrationPolicyResponseSchema.parse({
        emailVerification,
        consentPolicy: serviceConsentPolicy,
      }),
      { emailVerification, consentPolicy: serviceConsentPolicy },
    );
  for (const input of [
    {},
    { emailVerification: true },
    { emailVerification: "optional" },
    { emailVerification: "required", secret: "not-public" },
  ])
    assert.equal(
      registrationPolicyResponseSchema.safeParse(input).success,
      false,
    );
});

test("challenge responses contain only the capability, expiry and bounded resend delay", () => {
  assert.deepEqual(
    emailRegistrationChallengeSchema.parse(challenge),
    challenge,
  );
  for (const resendAfterSeconds of [0, 600])
    assert.equal(
      emailRegistrationChallengeSchema.safeParse({
        ...challenge,
        resendAfterSeconds,
      }).success,
      true,
    );
  for (const change of [
    { resendAfterSeconds: -1 },
    { resendAfterSeconds: 601 },
    { resendAfterSeconds: 1.5 },
    { resendAfterSeconds: "60" },
    { challengeId: "not-a-uuid" },
    { proof: "ab".repeat(31) },
    { proof: "ab".repeat(33) },
    { proof: "g".repeat(64) },
    { proof: "AB".repeat(32) },
    { expiresAt: "2099-01-01" },
    { expiresAt: "2099-02-30T12:00:00Z" },
    { code: "123456" },
    { otp: "123456" },
    { email: "synthetic@example.test" },
    { password: "synthetic-password" },
    { token: "not-a-session" },
  ])
    assert.equal(
      emailRegistrationChallengeSchema.safeParse({ ...challenge, ...change })
        .success,
      false,
    );
  for (const field of Object.keys(challenge)) {
    const missing = { ...challenge } as Record<string, unknown>;
    delete missing[field];
    assert.equal(
      emailRegistrationChallengeSchema.safeParse(missing).success,
      false,
    );
  }
});

test("resend and confirm are strict capability commands and codes remain six ASCII digits", () => {
  assert.deepEqual(emailRegistrationResendSchema.parse(capability), capability);
  for (const code of ["000000", "123456", "999999"])
    assert.deepEqual(
      emailRegistrationConfirmSchema.parse({ ...capability, code }),
      { ...capability, code },
    );
  for (const code of [
    123456,
    "12345",
    "1234567",
    " 123456",
    "１２３４５６",
    "abcdef",
  ])
    assert.equal(
      emailRegistrationConfirmSchema.safeParse({ ...capability, code }).success,
      false,
    );
  for (const schema of [
    emailRegistrationResendSchema,
    emailRegistrationConfirmSchema,
  ]) {
    const valid = {
      ...capability,
      ...(schema === emailRegistrationConfirmSchema ? { code: "123456" } : {}),
    };
    for (const change of [
      { proof: "invalid-proof" },
      { challengeId: "invalid-id" },
      { password: "not-needed" },
      { email: "not-needed@example.test" },
      { remember: true },
    ])
      assert.equal(schema.safeParse({ ...valid, ...change }).success, false);
  }
  assert.equal(
    emailRegistrationResendSchema.safeParse({ ...capability, code: "123456" })
      .success,
    false,
  );
});

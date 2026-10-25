import assert from "node:assert/strict";
import test from "node:test";
import {
  isEmailRegistrationCode,
  pendingEmailRegistration,
  registrationClock,
} from "./email-registration-state";

test("registration timer uses only server expiry and issued resend cooldown", () => {
  const pending = pendingEmailRegistration(
    "person@example.test",
    {
      challengeId: "challenge",
      proof: "proof",
      expiresAt: "2026-10-23T10:10:00Z",
      resendAfterSeconds: 45,
    },
    Date.parse("2026-10-23T10:00:00Z"),
    { policyVersion: "synthetic-v1", personalData: true, marketing: false },
  );
  assert.deepEqual(
    registrationClock(pending, Date.parse("2026-10-23T10:00:01.1Z")),
    {
      expired: false,
      resendSeconds: 44,
    },
  );
  assert.deepEqual(
    registrationClock(pending, Date.parse("2026-10-23T10:10:00Z")),
    {
      expired: true,
      resendSeconds: 0,
    },
  );
  assert.equal("password" in pending, false);
  assert.equal("code" in pending, false);
  assert.equal(
    registrationClock({ ...pending, expiresAt: "invalid" }, 0).expired,
    true,
  );
});

test("pending registration freezes the explicit choice for resend without storing credentials", () => {
  const original = {
    policyVersion: "synthetic-v1",
    personalData: true as const,
    marketing: false,
  };
  const pending = pendingEmailRegistration(
    "test@example.test",
    {
      challengeId: "challenge",
      proof: "proof",
      expiresAt: "2099-01-01T00:00:00Z",
      resendAfterSeconds: 60,
    },
    0,
    original,
  );
  original.marketing = true;
  const resent = pendingEmailRegistration(
    pending.email,
    {
      challengeId: pending.challengeId,
      proof: pending.proof,
      expiresAt: "2099-01-01T00:00:00Z",
      resendAfterSeconds: 60,
    },
    1000,
    pending.consents,
  );
  assert.deepEqual(resent.consents, {
    policyVersion: "synthetic-v1",
    personalData: true,
    marketing: false,
  });
});

test("confirmation accepts exactly six digits and does not reinterpret input", () => {
  assert.equal(isEmailRegistrationCode("012345"), true);
  for (const code of [
    "12345",
    "1234567",
    " 123456",
    "123456 ",
    "123abc",
    "١٢٣٤٥٦",
    "",
  ]) {
    assert.equal(isEmailRegistrationCode(code), false);
  }
});

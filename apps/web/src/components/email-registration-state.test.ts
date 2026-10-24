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

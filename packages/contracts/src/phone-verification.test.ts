import assert from "node:assert/strict";
import test from "node:test";
import {
  russianMobilePhoneSchema,
  phoneVerificationPolicySchema,
  phoneVerificationStartSchema,
  phoneVerificationResendSchema,
  phoneVerificationConfirmSchema,
  phoneVerificationChallengeSchema,
  phoneVerificationReceiptSchema,
} from "./phone-verification.js";

const phone = "+79990000000";
const expectedDeliveryProvider = "prosto_sms";
const challenge = {
  challengeId: "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  proof: "ab".repeat(32),
  expiresAt: "2099-01-01T12:00:00.000Z",
  resendAfterSeconds: 60,
};
const capability = {
  challengeId: challenge.challengeId,
  proof: challenge.proof,
  phone,
};
const receipt = {
  operationId: "b274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
  grantedMicros: 500_000_000,
  alreadyGranted: false,
};

test("Russian mobile numbers normalize to one canonical identity before a phone command", () => {
  for (const raw of [
    phone,
    "79990000000",
    "89990000000",
    "8 (999) 000-00-00",
    "+7 (999) 000-00-00",
    "  +7 999 000 00 00  ",
  ]) {
    assert.equal(russianMobilePhoneSchema.parse(raw), phone);
    assert.deepEqual(
      phoneVerificationStartSchema.parse({
        phone: raw,
        expectedDeliveryProvider,
      }),
      { phone, expectedDeliveryProvider },
    );
    assert.deepEqual(
      phoneVerificationResendSchema.parse({
        ...capability,
        phone: raw,
        expectedDeliveryProvider,
      }),
      { ...capability, expectedDeliveryProvider },
    );
    assert.deepEqual(
      phoneVerificationConfirmSchema.parse({
        ...capability,
        phone: raw,
        code: "012345",
      }),
      { ...capability, code: "012345" },
    );
  }
});

test("normalization never reinterprets Kazakhstan, landlines, recipient lists, extensions or Unicode digits as RF mobiles", () => {
  for (const raw of [
    null,
    79990000000,
    "",
    "9990000000",
    "+77010000000",
    "77010000000",
    "+76123456789",
    "+74991234567",
    "+19990000000",
    "0079990000000",
    "+79990000000 доб. 1",
    "+79990000000,+79990000001",
    "+79990000000;+79990000001",
    "+7999\n0000000",
    "+٧٩٩٩٠٠٠٠٠٠٠",
    "+７９９９０００００００",
    " ".repeat(33) + phone,
  ])
    assert.equal(russianMobilePhoneSchema.safeParse(raw).success, false);
});

test("phone policy is a strict explicit availability state with exactly the approved gift", () => {
  for (const phoneVerification of [
    "disabled",
    "unavailable",
    "required",
  ] as const)
    assert.deepEqual(
      phoneVerificationPolicySchema.parse({
        phoneVerification,
        deliveryProvider: phoneVerification === "disabled" ? "none" : "sms_ru",
        giftAmountMicros: 500_000_000,
        giftStatus:
          phoneVerification === "required" ? "eligible" : "unavailable",
      }),
      {
        phoneVerification,
        deliveryProvider: phoneVerification === "disabled" ? "none" : "sms_ru",
        giftAmountMicros: 500_000_000,
        giftStatus:
          phoneVerification === "required" ? "eligible" : "unavailable",
      },
    );
  for (const giftStatus of ["email_required", "eligible", "granted"] as const)
    assert.equal(
      phoneVerificationPolicySchema.parse({
        phoneVerification: "required",
        deliveryProvider: "prosto_sms",
        giftAmountMicros: 500_000_000,
        giftStatus,
      }).giftStatus,
      giftStatus,
    );
  for (const value of [
    {},
    { phoneVerification: true, giftAmountMicros: 500_000_000 },
    { phoneVerification: "optional", giftAmountMicros: 500_000_000 },
    { phoneVerification: "required" },
    { phoneVerification: "required", giftAmountMicros: "500000000" },
    { phoneVerification: "required", giftAmountMicros: 500_000_001 },
    { phoneVerification: "required", giftAmountMicros: 500_000_000 },
    {
      phoneVerification: "required",
      giftAmountMicros: 500_000_000,
      giftStatus: "unavailable",
    },
    {
      phoneVerification: "disabled",
      giftAmountMicros: 500_000_000,
      giftStatus: "eligible",
    },
    {
      phoneVerification: "unavailable",
      giftAmountMicros: 500_000_000,
      giftStatus: "granted",
    },
    {
      phoneVerification: "required",
      giftAmountMicros: 500_000_000,
      giftStatus: "unknown",
    },
    {
      phoneVerification: "required",
      giftAmountMicros: 500_000_000,
      giftStatus: "eligible",
      apiId: "synthetic-secret",
    },
  ])
    assert.equal(
      phoneVerificationPolicySchema.safeParse({
        deliveryProvider: "sms_ru",
        ...value,
      }).success,
      false,
    );
});

test("policy requires an explicit server delivery provider, never infers it from availability", () => {
  const base = { giftAmountMicros: 500_000_000 };
  for (const deliveryProvider of ["sms_ru", "prosto_sms"] as const)
    for (const phoneVerification of ["unavailable", "required"] as const) {
      const value = {
        ...base,
        phoneVerification,
        deliveryProvider,
        giftStatus:
          phoneVerification === "required" ? "eligible" : "unavailable",
      };
      assert.deepEqual(phoneVerificationPolicySchema.parse(value), value);
    }
  assert.equal(
    phoneVerificationPolicySchema.safeParse({
      ...base,
      phoneVerification: "disabled",
      giftStatus: "unavailable",
      deliveryProvider: "none",
    }).success,
    true,
  );
  for (const deliveryProvider of [
    undefined,
    null,
    true,
    "prosto",
    "SMS.RU",
    "",
  ])
    assert.equal(
      phoneVerificationPolicySchema.safeParse({
        ...base,
        phoneVerification: "required",
        giftStatus: "eligible",
        deliveryProvider,
      }).success,
      false,
    );
  for (const deliveryProvider of ["sms_ru", "prosto_sms"])
    assert.equal(
      phoneVerificationPolicySchema.safeParse({
        ...base,
        phoneVerification: "disabled",
        giftStatus: "unavailable",
        deliveryProvider,
      }).success,
      false,
    );
  for (const phoneVerification of ["unavailable", "required"])
    assert.equal(
      phoneVerificationPolicySchema.safeParse({
        ...base,
        phoneVerification,
        giftStatus:
          phoneVerification === "required" ? "eligible" : "unavailable",
        deliveryProvider: "none",
      }).success,
      false,
    );
});

test("phone commands retain strict capability and six-ASCII-digit checks without arbitrary fields", () => {
  for (const schema of [
    phoneVerificationStartSchema,
    phoneVerificationResendSchema,
    phoneVerificationConfirmSchema,
  ]) {
    const valid =
      schema === phoneVerificationStartSchema
        ? { phone, expectedDeliveryProvider }
        : schema === phoneVerificationResendSchema
          ? { ...capability, expectedDeliveryProvider }
          : { ...capability, code: "012345" };
    assert.equal(schema.safeParse(valid).success, true);
    for (const change of [
      { userId: "another-user" },
      { grantAmount: 500_000_000 },
      { accepted: true },
      { provider: "sms_ru" },
      { password: "synthetic-secret" },
      { email: "synthetic@example.test" },
      { phone: "+77010000000" },
    ])
      assert.equal(schema.safeParse({ ...valid, ...change }).success, false);
    for (const key of Object.keys(valid)) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      assert.equal(schema.safeParse(missing).success, false);
    }
  }
  for (const schema of [
    phoneVerificationResendSchema,
    phoneVerificationConfirmSchema,
  ]) {
    const valid = {
      ...capability,
      ...(schema === phoneVerificationResendSchema
        ? { expectedDeliveryProvider }
        : {}),
      ...(schema === phoneVerificationConfirmSchema ? { code: "012345" } : {}),
    };
    for (const change of [
      { challengeId: "invalid-id" },
      { proof: "AB".repeat(32) },
      { proof: "ab".repeat(31) },
      { proof: "g".repeat(64) },
    ])
      assert.equal(schema.safeParse({ ...valid, ...change }).success, false);
  }
  assert.equal(
    phoneVerificationResendSchema.safeParse({ ...capability, code: "012345" })
      .success,
    false,
  );
  for (const code of [
    123456,
    "12345",
    "1234567",
    " 123456",
    "123456\n",
    "１２３４５６",
    "abcdef",
  ])
    assert.equal(
      phoneVerificationConfirmSchema.safeParse({ ...capability, code }).success,
      false,
    );
});

test("every outbound phone command requires the exact consented provider, not a default, none or arbitrary provider", () => {
  for (const schema of [
    phoneVerificationStartSchema,
    phoneVerificationResendSchema,
  ]) {
    const base =
      schema === phoneVerificationStartSchema ? { phone } : capability;
    for (const expectedDeliveryProvider of ["sms_ru", "prosto_sms"])
      assert.equal(
        schema.safeParse({ ...base, expectedDeliveryProvider }).success,
        true,
      );
    for (const expectedDeliveryProvider of [
      undefined,
      null,
      "none",
      "smsru",
      "prosto",
      true,
    ])
      assert.equal(
        schema.safeParse({ ...base, expectedDeliveryProvider }).success,
        false,
      );
  }
  // Confirmation does not disclose the number to a provider, and retains its
  // existing strict local capability/OTP command rather than an unused field.
  assert.equal(
    phoneVerificationConfirmSchema.safeParse({
      ...capability,
      code: "012345",
      expectedDeliveryProvider,
    }).success,
    false,
  );
});

test("phone challenges expose only a bounded ephemeral capability, never delivery status, code or identity", () => {
  assert.deepEqual(
    phoneVerificationChallengeSchema.parse(challenge),
    challenge,
  );
  for (const change of [
    { phone },
    { phoneKey: "synthetic-private-phone-key" },
    { code: "012345" },
    { otp: "012345" },
    { apiId: "synthetic-secret" },
    { accepted: true },
    { simulated: false },
    { providerMessageId: "000000-10000000" },
    { proof: "invalid-proof" },
    { resendAfterSeconds: 601 },
    { resendAfterSeconds: "60" },
    { expiresAt: "2099-02-30T12:00:00Z" },
  ])
    assert.equal(
      phoneVerificationChallengeSchema.safeParse({ ...challenge, ...change })
        .success,
      false,
    );
});

test("gift receipts require an exact amount and durable operation ID, not a simulated SMS success", () => {
  for (const alreadyGranted of [false, true])
    assert.deepEqual(
      phoneVerificationReceiptSchema.parse({ ...receipt, alreadyGranted }),
      { ...receipt, alreadyGranted },
    );
  for (const change of [
    { operationId: "invalid-id" },
    { grantedMicros: 0 },
    { grantedMicros: 499_999_999 },
    { grantedMicros: 500_000_001 },
    { grantedMicros: "500000000" },
    { alreadyGranted: "true" },
    { phone },
    { code: "012345" },
    { token: "synthetic-token" },
    { accepted: true },
    { simulated: true },
  ])
    assert.equal(
      phoneVerificationReceiptSchema.safeParse({ ...receipt, ...change })
        .success,
      false,
    );
  for (const key of Object.keys(receipt)) {
    const missing: Record<string, unknown> = { ...receipt };
    delete missing[key];
    assert.equal(
      phoneVerificationReceiptSchema.safeParse(missing).success,
      false,
    );
  }
  assert.equal(
    phoneVerificationReceiptSchema.safeParse({
      provider: "sms_ru",
      mode: "test",
      accepted: false,
      simulated: true,
    }).success,
    false,
  );
});

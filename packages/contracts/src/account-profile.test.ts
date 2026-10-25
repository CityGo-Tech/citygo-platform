import assert from "node:assert/strict";
import test from "node:test";
import {
  accountProfileSchema,
  accountEmailVerificationStartSchema,
  accountEmailVerificationConfirmSchema,
  accountEmailVerificationReceiptSchema,
} from "./account-profile.js";

const profile = {
  userId: "9007199254740993",
  email: "owner@example.test",
  emailVerified: false,
  phoneVerified: false,
  giftStatus: "unavailable",
  emailConfirmation: "available",
};

test("contact facts are explicit and cannot contain a phone, proof or model context", () => {
  assert.deepEqual(accountProfileSchema.parse(profile), profile);
  for (const secret of ["phone", "phoneKey", "proof", "code", "passwordHash"])
    assert.equal(
      accountProfileSchema.safeParse({ ...profile, [secret]: "private" })
        .success,
      false,
    );
  assert.equal(
    accountProfileSchema.safeParse({ ...profile, emailVerified: undefined })
      .success,
    false,
  );
  assert.equal(
    accountProfileSchema.safeParse({ ...profile, giftStatus: "unknown" })
      .success,
    false,
  );
});

test("a bootstrap account cannot claim a verified or confirmable nonexistent contact", () => {
  assert.equal(
    accountProfileSchema.safeParse({
      ...profile,
      email: null,
      emailConfirmation: "unavailable",
    }).success,
    true,
  );
  assert.equal(
    accountProfileSchema.safeParse({
      ...profile,
      email: null,
      emailVerified: true,
      emailConfirmation: "unavailable",
    }).success,
    false,
  );
  assert.equal(
    accountProfileSchema.safeParse({ ...profile, email: null }).success,
    false,
  );
});

test("email commands do not let the caller choose an address or another owner", () => {
  assert.deepEqual(accountEmailVerificationStartSchema.parse({}), {});
  for (const input of [{ userId: "7" }, { email: "other@example.test" }])
    assert.equal(
      accountEmailVerificationStartSchema.safeParse(input).success,
      false,
    );
  const confirm = {
    challengeId: "4a661457-835c-45f7-ad42-e1b0ef366fb9",
    proof: "ab".repeat(32),
    code: "001234",
  };
  assert.deepEqual(
    accountEmailVerificationConfirmSchema.parse(confirm),
    confirm,
  );
  for (const input of [
    { ...confirm, userId: "7" },
    { ...confirm, code: "12345" },
    { ...confirm, code: "１２３４５６" },
  ])
    assert.equal(
      accountEmailVerificationConfirmSchema.safeParse(input).success,
      false,
    );
});

test("confirmation receipt grants no session, role, balance or phone verification", () => {
  const receipt = { userId: profile.userId, emailVerified: true };
  assert.deepEqual(
    accountEmailVerificationReceiptSchema.parse(receipt),
    receipt,
  );
  for (const input of [
    { ...receipt, token: "private" },
    { ...receipt, role: "super_admin" },
    { ...receipt, giftGranted: true },
    { ...receipt, emailVerified: false },
  ])
    assert.equal(
      accountEmailVerificationReceiptSchema.safeParse(input).success,
      false,
    );
});

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import {
  protectedPhoneCodec,
  ProtectedPhoneError,
  type ProtectedPhoneBinding,
} from "./protected-phone.js";

// Fictional values only. These tests never consult config/env or any provider.
const secret = "b".repeat(64);
const phone = "+79990000001";
const codec = protectedPhoneCodec(secret);
const binding: ProtectedPhoneBinding = {
  proofUserId: "42",
  phoneKey: createHmac("sha256", Buffer.from(secret, "hex"))
    .update(JSON.stringify(["phone-identity", phone]))
    .digest("hex"),
  sourceChallengeId: randomUUID(),
};
const rejected = (fn: () => unknown) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ProtectedPhoneError);
    assert.equal(error.code, "PHONE_CONTACT_DATA_ERROR");
    assert.equal(error.message, "Не удалось прочитать сохранённый контакт");
    assert.ok(!String(error).includes(phone));
    assert.ok(!String(error).includes(secret));
    return true;
  });
};

test("verified phone round-trips with randomized AES-GCM envelope, bound to exact OTP identity", () => {
  const first = codec.protect(phone, binding);
  const second = codec.protect(phone, binding);
  assert.notEqual(first, second);
  assert.ok(first.length <= 256);
  assert.match(
    first,
    /^pc1\.[a-f0-9]{64}\.[a-f0-9]{24}\.[a-f0-9]{24}\.[a-f0-9]{32}$/,
  );
  assert.ok(!first.includes(phone));
  assert.ok(!first.includes(phone.slice(1)));
  assert.equal(codec.reveal(first, binding), phone);
  assert.equal(codec.reveal(second, binding), phone);
});

test("each envelope part is authenticated; bad versions, truncation and unexpected data fail closed", () => {
  const saved = codec.protect(phone, binding);
  for (let part = 1; part < 5; part++) {
    const segments = saved.split(".");
    const segment = segments[part]!;
    segments[part] = (segment[0] === "a" ? "b" : "a") + segment.slice(1);
    rejected(() => codec.reveal(segments.join("."), binding));
  }
  for (const input of [
    "",
    phone,
    saved.replace("pc1.", "pc2."),
    saved.slice(0, -1),
    saved + ".extra",
    saved + "\n",
    saved.toUpperCase(),
    saved.replace(saved.split(".")[3]!, "00".repeat(1000)),
  ])
    rejected(() => codec.reveal(input, binding));
});

test("ciphertext cannot move to a different account, phone key, challenge or master key", () => {
  const saved = codec.protect(phone, binding);
  for (const replacement of [
    { proofUserId: "43" },
    { sourceChallengeId: randomUUID() },
    { phoneKey: "a".repeat(64) },
  ])
    rejected(() => codec.reveal(saved, { ...binding, ...replacement }));
  rejected(() => protectedPhoneCodec("a".repeat(64)).reveal(saved, binding));
});

test("capture requires a canonical normalized phone matching the unchanged HMAC identity", () => {
  for (const input of [
    "89990000001",
    "8 (999) 000-00-01",
    "+79990000002",
    "+77123456789",
    "not a phone",
  ])
    rejected(() => codec.protect(input, binding));
  rejected(() => codec.protect(phone, { ...binding, proofUserId: "0" }));
  rejected(() => protectedPhoneCodec("not-a-secret"));
  rejected(() => protectedPhoneCodec("b".repeat(63)));
});

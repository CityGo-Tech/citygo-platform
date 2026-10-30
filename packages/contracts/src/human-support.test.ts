import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupportRequestSchema,
  supportRequestIdSchema,
  updateSupportRequestStatusSchema,
  supportRequestBodySchema,
  supportRequestBodyLength,
} from "./human-support.js";
test("support requests require bounded explicit text and operation identity without caller owner or AI fields", () => {
  const valid = {
    operationId: "f0db50c4-13e8-4fc6-8064-054ca970e6c1",
    body: "  Помогите разобраться с первым шагом переезда.  ",
  };
  assert.equal(createSupportRequestSchema.parse(valid).body, valid.body.trim());
  for (const body of [" ", "a".repeat(19), "a".repeat(4001)])
    assert.equal(
      createSupportRequestSchema.safeParse({ ...valid, body }).success,
      false,
    );
  for (const extra of [
    { userId: "2" },
    { threadId: "3" },
    { aiMode: "balanced" },
  ])
    assert.equal(
      createSupportRequestSchema.safeParse({ ...valid, ...extra }).success,
      false,
    );
  assert.equal(
    supportRequestIdSchema.safeParse("9007199254740993").success,
    true,
  );
  for (const id of ["01", "1\n", "9223372036854775808"])
    assert.equal(supportRequestIdSchema.safeParse(id).success, false);
  assert.equal(
    updateSupportRequestStatusSchema.safeParse({
      expectedRevision: 1,
      status: "in_progress",
    }).success,
    false,
  );
});
test("support text uses PostgreSQL code point lengths and rejects NUL or malformed Unicode before storage", () => {
  assert.equal(supportRequestBodyLength("😀".repeat(10)), 10);
  assert.equal(
    supportRequestBodySchema.safeParse("😀".repeat(10)).success,
    false,
  );
  for (const body of ["😀".repeat(20), "😀".repeat(4000), "a".repeat(4000)])
    assert.equal(supportRequestBodySchema.parse(body), body);
  for (const body of [
    "😀".repeat(4001),
    "a".repeat(20) + "\0",
    "a".repeat(20) + "\ud800",
    "\udc00" + "a".repeat(20),
  ])
    assert.equal(supportRequestBodySchema.safeParse(body).success, false);
});

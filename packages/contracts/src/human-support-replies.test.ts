import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupportReplySchema,
  supportReplyBodySchema,
  supportRepliesQuerySchema,
} from "./human-support-replies.js";
test("support replies strictly bind revision and operation, preserve Unicode and reject forbidden data", () => {
  const x = {
    operationId: "41111111-1111-4111-8111-111111111111",
    expectedRevision: 1,
    body: "  Ответ 😀  ",
  };
  assert.equal(createSupportReplySchema.parse(x).body, "Ответ 😀");
  assert.equal(supportReplyBodySchema.parse("😀".repeat(4000)).length, 8000);
  for (const body of [" ", "a".repeat(4001), "a\0b", "a\ud800"])
    assert.equal(supportReplyBodySchema.safeParse(body).success, false);
  for (const extra of [
    { userId: "1" },
    { authorId: "1" },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
  ])
    assert.equal(
      createSupportReplySchema.safeParse({ ...x, ...extra }).success,
      false,
    );
  for (const before of ["01", "1\n", "9223372036854775808"])
    assert.equal(
      supportRepliesQuerySchema.safeParse({ before }).success,
      false,
    );
});

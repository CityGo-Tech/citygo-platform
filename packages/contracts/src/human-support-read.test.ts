import assert from "node:assert/strict";
import test from "node:test";
import {
  markSupportRepliesReadSchema,
  supportReadResultSchema,
  supportUpdatesPageSchema,
} from "./human-support-read.js";
test("support read contracts reject implicit reads, foreign properties and inconsistent totals; bigint IDs stay decimal strings", () => {
  assert.deepEqual(
    markSupportRepliesReadSchema.parse({ throughReplyId: "9007199254740993" }),
    { throughReplyId: "9007199254740993" },
  );
  for (const value of [
    {},
    { throughReplyId: 1 },
    { throughReplyId: "0" },
    { throughReplyId: "1", userId: "2" },
    { throughReplyId: "1", all: true },
  ])
    assert.equal(markSupportRepliesReadSchema.safeParse(value).success, false);
  const page = {
    userId: "1",
    unreadRequests: 1,
    unreadReplies: 2,
    requests: [
      { requestId: "2", lastReplyId: "9007199254740993", unreadReplies: 2 },
    ],
    nextBefore: null,
  };
  assert.deepEqual(supportUpdatesPageSchema.parse(page), page);
  for (const changed of [
    { unreadRequests: 0 },
    { unreadReplies: 0 },
    { unreadReplies: 1 },
    { unreadRequests: 201 },
    { body: "private" },
  ])
    assert.equal(
      supportUpdatesPageSchema.safeParse({ ...page, ...changed }).success,
      false,
    );
  assert.equal(
    supportReadResultSchema.safeParse({
      userId: "1",
      requestId: "2",
      throughReplyId: "3",
      unreadReplies: -1,
    }).success,
    false,
  );
});

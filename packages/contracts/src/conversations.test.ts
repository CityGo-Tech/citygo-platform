import assert from "node:assert/strict";
import test from "node:test";
import {
  agentKeys,
  conversationIdSchema,
  conversationStartSchema,
  conversationListQuerySchema,
} from "./platform.js";
import {
  conversationListResponseSchema,
  conversationDetailResponseSchema,
  dashboardResponseSchema,
} from "./responses.js";

test("conversation inputs accept only five assistant keys and exact positive int64 IDs", () => {
  assert.deepEqual(conversationStartSchema.parse({}), {});
  for (const agentKey of agentKeys)
    assert.deepEqual(conversationStartSchema.parse({ agentKey }), { agentKey });
  for (const input of [
    { agentKey: "bubble" },
    { agentKey: "routerai" },
    { agentKey: null },
    { ownerId: "1" },
    { agentKey: "housing", model: "forged" },
  ])
    assert.equal(conversationStartSchema.safeParse(input).success, false);
  for (const id of ["1", "9007199254740993", "9223372036854775807"])
    assert.equal(conversationIdSchema.parse(id), id);
  for (const id of [
    "0",
    "01",
    "-1",
    "1.0",
    " 1",
    "1e2",
    "9223372036854775808",
    "1;select 1",
    1,
  ])
    assert.equal(conversationIdSchema.safeParse(id).success, false);
  assert.deepEqual(
    conversationListQuerySchema.parse({ before: "9007199254740993" }),
    {
      before: "9007199254740993",
    },
  );
  assert.equal(
    conversationListQuerySchema.safeParse({ limit: 1000 }).success,
    false,
  );
});

const summary = {
  id: "9007199254740993",
  agentKey: "housing",
  assistantKey: "housing",
  closed: false,
  updatedAt: "2026-10-22T12:00:00.000Z",
  preview: "С чего начать?",
};
test("conversation lists are bounded and pinned roles cannot contradict their assistant", () => {
  const page = {
    userId: "1",
    conversations: [summary],
    nextCursor: summary.id,
  };
  assert.deepEqual(conversationListResponseSchema.parse(page), page);
  for (const invalid of [
    { ...page, conversations: Array.from({ length: 21 }, () => summary) },
    { ...page, nextCursor: "9223372036854775808" },
    { ...page, conversations: [{ ...summary, preview: "x".repeat(241) }] },
    { ...page, conversations: [{ ...summary, assistantKey: "support" }] },
    { ...page, conversations: [{ ...summary, updatedAt: "not-a-date" }] },
    { ...page, userId: undefined },
    { ...page, userId: "9223372036854775808" },
  ])
    assert.equal(
      conversationListResponseSchema.safeParse(invalid).success,
      false,
    );
  assert.equal(
    conversationListResponseSchema.safeParse({
      userId: "1",
      conversations: [{ ...summary, assistantKey: null, closed: true }],
      nextCursor: null,
    }).success,
    true,
  );
});

test("legacy dashboards remain readable and new detail requires explicit pinned metadata", () => {
  const legacy = { id: "1", agentKey: "support", messages: [] };
  assert.equal(
    conversationDetailResponseSchema.safeParse({ userId: "1", thread: legacy })
      .success,
    false,
  );
  const legacyDetail = { ...legacy, assistantKey: null, closed: false };
  assert.deepEqual(
    conversationDetailResponseSchema.parse({
      userId: "1",
      thread: legacyDetail,
    }),
    { userId: "1", thread: legacyDetail },
  );
  const pinned = {
    ...legacy,
    agentKey: "housing",
    assistantKey: "housing",
    closed: true,
  };
  assert.deepEqual(
    conversationDetailResponseSchema.parse({ userId: "1", thread: pinned }),
    {
      userId: "1",
      thread: pinned,
    },
  );
  assert.equal(
    conversationDetailResponseSchema.safeParse({
      userId: "1",
      thread: { ...pinned, assistantKey: "support" },
    }).success,
    false,
  );
  const board = {
    user: { id: "1", email: "synthetic@example.test" },
    profile: null,
    xp: 0,
    quests: [],
    thread: legacy,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
  assert.equal(dashboardResponseSchema.safeParse(board).success, true);
  assert.equal(
    dashboardResponseSchema.safeParse({ ...board, thread: pinned }).success,
    true,
  );
});

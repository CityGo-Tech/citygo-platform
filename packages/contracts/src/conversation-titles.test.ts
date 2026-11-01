import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationCustomTitleSchema,
  conversationTitleSchema,
  updateConversationTitleSchema,
} from "./conversation-titles.js";
import { conversationListResponseSchema } from "./responses.js";
test("conversation titles are bounded single-line Unicode with exact decimal CAS revisions", () => {
  assert.equal(conversationCustomTitleSchema.parse("  Жильё 🏡  "), "Жильё 🏡");
  assert.equal(conversationCustomTitleSchema.parse("🏡".repeat(40)).length, 80);
  for (const title of [
    "",
    " ",
    "a\nb",
    "a\tb",
    "x\u0000",
    "a\u007f",
    "\ud800",
    "🏡".repeat(41),
  ])
    assert.equal(
      conversationCustomTitleSchema.safeParse(title).success,
      false,
      JSON.stringify(title),
    );
  assert.deepEqual(
    updateConversationTitleSchema.parse({
      title: null,
      expectedRevision: "9007199254740993",
    }),
    { title: null, expectedRevision: "9007199254740993" },
  );
  for (const expectedRevision of [1, "01", "-1", "9223372036854775807"])
    assert.equal(
      updateConversationTitleSchema.safeParse({
        title: "Название",
        expectedRevision,
      }).success,
      false,
    );
  assert.equal(
    updateConversationTitleSchema.safeParse({
      title: "Название",
      expectedRevision: "0",
      userId: "2",
    }).success,
    false,
  );
  assert.equal(
    conversationTitleSchema.safeParse({
      userId: "1",
      threadId: "2",
      title: "invented",
      revision: "0",
      updatedAt: null,
    }).success,
    false,
  );
  assert.equal(
    conversationTitleSchema.safeParse({
      userId: "1",
      threadId: "2",
      title: "Persisted",
      revision: "1",
      updatedAt: null,
    }).success,
    false,
  );
});
test("old conversation pages remain accepted and title fields must arrive together", () => {
  const item = {
    id: "2",
    agentKey: "support",
    assistantKey: "support",
    closed: false,
    updatedAt: "2026-11-01T00:00:00Z",
    preview: "Вопрос",
  };
  const page = (value: unknown) => ({
    userId: "1",
    conversations: [value],
    nextCursor: null,
  });
  assert.equal(
    conversationListResponseSchema.safeParse(page(item)).success,
    true,
  );
  assert.equal(
    conversationListResponseSchema.safeParse(
      page({ ...item, customTitle: null, titleRevision: "0" }),
    ).success,
    true,
  );
  assert.equal(
    conversationListResponseSchema.safeParse(
      page({ ...item, customTitle: "Название" }),
    ).success,
    false,
  );
});

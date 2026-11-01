import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationExportSchema,
  CONVERSATION_EXPORT_MAX_MESSAGES,
} from "./conversation-export.js";
const message = (id = "9007199254740993") => ({
  id,
  role: "assistant",
  content: "Полный текст 😀\n<script>literal</script>",
  agentKey: "support",
  status: "complete",
  failureCode: null,
  createdAt: "2026-11-01T10:00:00Z",
});
const snapshot = () => ({
  version: 1,
  userId: "1",
  generatedAt: "2026-11-01T10:01:00Z",
  thread: {
    id: "9223372036854775807",
    agentKey: "support",
    assistantKey: null,
    closed: true,
  },
  messages: [message()],
});
test("complete export preserves exact int64 IDs, Unicode and persisted interrupted/empty messages", () => {
  const value = snapshot();
  assert.deepEqual(conversationExportSchema.parse(value), value);
  assert.equal(
    conversationExportSchema.safeParse({ ...value, messages: [] }).success,
    true,
  );
  assert.equal(
    conversationExportSchema.safeParse({
      ...value,
      messages: [
        {
          ...message(),
          content: "",
          status: "interrupted",
          failureCode: "AI_CREDIT_EXHAUSTED",
        },
      ],
    }).success,
    true,
  );
});
test("whole export fails closed for malformed IDs, duplicate/order changes, private extras, bad state and Unicode", () => {
  const value = snapshot();
  for (const changed of [
    { ...value, userId: "01" },
    { ...value, userId: "1\n" },
    { ...value, version: 2 },
    { ...value, generatedAt: "now" },
    { ...value, extra: "PRIVATE" },
    { ...value, thread: { ...value.thread, id: "9223372036854775808" } },
    { ...value, thread: { ...value.thread, assistantKey: "housing" } },
    { ...value, messages: [message(), message()] },
    { ...value, messages: [message("2"), message("1")] },
    ...["not-an-id", "1\n", "0", "9223372036854775808"].map((id) => ({
      ...value,
      messages: [message(id)],
    })),
    ...["bad\0text", "bad\ud800text"].map((content) => ({
      ...value,
      messages: [{ ...message(), content }],
    })),
    { ...value, messages: [{ ...message(), role: "system" }] },
    { ...value, messages: [{ ...message(), status: "running" }] },
    {
      ...value,
      messages: [{ ...message(), failureCode: "AI_CREDIT_EXHAUSTED" }],
    },
    {
      ...value,
      messages: [{ ...message(), generation: { model: "PRIVATE" } }],
    },
    {
      ...value,
      messages: Array.from(
        { length: CONVERSATION_EXPORT_MAX_MESSAGES + 1 },
        (_, n) => message(String(n + 1)),
      ),
    },
    {
      ...value,
      messages: Array.from({ length: 7 }, (_, n) => ({
        ...message(String(n + 1)),
        content: "Я".repeat(500000),
      })),
    },
  ])
    assert.equal(conversationExportSchema.safeParse(changed).success, false);
});

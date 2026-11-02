import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantContextInputSchema,
  assistantContextPreviewSchema,
} from "./assistant-context.js";
const response = {
  userId: "9007199254740993",
  threadId: "9007199254740994",
  generatedAt: "2026-11-02T00:00:00Z",
  profile: {
    targetCity: null,
    monthlyBudget: null,
    moveTargetDate: null,
    household: null,
  },
  agentKey: "support",
  closed: false,
  draftIncluded: false,
  messages: [],
};
test("context preview keeps opaque IDs and unknown profile fields, accepting only the selected read scope", () => {
  assert.deepEqual(assistantContextPreviewSchema.parse(response), response);
  assert.deepEqual(
    assistantContextInputSchema.parse({ threadId: null, draft: "" }),
    { threadId: null, draft: "" },
  );
  for (const value of [
    { threadId: "../1", draft: "" },
    { threadId: "1", draft: "x".repeat(4001) },
    { threadId: "1", draft: "", userId: "2" },
    { threadId: "1", draft: "", confirmed: true },
  ])
    assert.equal(assistantContextInputSchema.safeParse(value).success, false);
});
test("preview cannot label incomplete/orphaned model output as completed conversation context", () => {
  const user = { role: "user", content: "Вопрос" },
    assistant = { role: "assistant", content: "Ответ" };
  assert.ok(
    assistantContextPreviewSchema.safeParse({
      ...response,
      messages: [user, assistant],
    }).success,
  );
  for (const messages of [
    [assistant, user],
    [user],
    [user, { ...assistant, content: " " }],
    Array(20).fill(user),
  ])
    assert.equal(
      assistantContextPreviewSchema.safeParse({ ...response, messages })
        .success,
      false,
    );
  assert.equal(
    assistantContextPreviewSchema.safeParse({
      ...response,
      threadId: null,
      messages: [user, assistant],
    }).success,
    false,
  );
});

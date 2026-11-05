import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardResponseSchema,
  conversationDetailResponseSchema,
} from "./responses.js";
import type { ModelGeneration } from "./llm.js";

const generation: ModelGeneration = {
  provider: "routerai",
  requestedModel: "openai/gpt-6.1-sol",
  model: "openai/gpt-6.1-sol",
  webSources: {
    version: "routerai_native_v1",
    citations: [
      { url: "https://example.org/housing", title: "Housing guidance" },
    ],
  },
};
const message = {
  id: "9007199254740993",
  role: "assistant",
  status: "complete",
  agentKey: "housing",
  content: "Синтетический ответ с источником.",
  generation,
};
const board = {
  user: { id: "1", email: "synthetic@example.test" },
  profile: null,
  xp: 0,
  quests: [],
  thread: {
    id: "1",
    agentKey: "housing",
    assistantKey: "housing",
    closed: false,
    messages: [message],
  },
  provider: "routerai",
  aiAccess: { policy: null, granted: false, dailyLimit: 0 },
};

test("complete web sources survive JSON dashboard and detail round trips; legacy messages remain valid", () => {
  const parsed = dashboardResponseSchema.parse(
    JSON.parse(JSON.stringify(board)),
  );
  assert.deepEqual(
    parsed.thread?.messages[0]?.generation?.webSources,
    generation.webSources,
  );
  const detail = conversationDetailResponseSchema.parse({
    userId: "1",
    thread: parsed.thread,
  });
  assert.deepEqual(
    detail.thread.messages[0]?.generation?.webSources,
    generation.webSources,
  );
  assert.equal(
    dashboardResponseSchema.safeParse({
      ...board,
      thread: {
        ...board.thread,
        messages: [{ ...message, generation: undefined }],
      },
    }).success,
    true,
  );
});

test("source claims are rejected on user, interrupted, mismatched or unsafe provider metadata", () => {
  const invalid = [
    { ...message, role: "user" },
    { ...message, status: "interrupted" },
    { ...message, content: "" },
    { ...message, generation: { ...generation, provider: "gigachat" } },
    {
      ...message,
      generation: {
        ...generation,
        requestedModel: "deepseek/deepseek-v4-pro-0813",
      },
    },
    { ...message, generation: { ...generation, model: undefined } },
    {
      ...message,
      generation: {
        ...generation,
        webSources: {
          ...generation.webSources,
          citations: [{ url: "https://127.0.0.1/", title: "Unsafe" }],
        },
      },
    },
  ];
  for (const value of invalid) {
    assert.equal(
      dashboardResponseSchema.safeParse({
        ...board,
        thread: { ...board.thread, messages: [value] },
      }).success,
      false,
    );
    assert.equal(
      conversationDetailResponseSchema.safeParse({
        userId: "1",
        thread: { ...board.thread, messages: [value] },
      }).success,
      false,
    );
  }
});

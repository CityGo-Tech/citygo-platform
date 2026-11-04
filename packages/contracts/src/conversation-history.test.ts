import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationMessagesQuerySchema,
  conversationMessagesResponseSchema,
} from "./conversation-history.js";

const message = (id: string) => ({
  id,
  role: "assistant" as const,
  content: "Synthetic saved answer",
  agentKey: "housing" as const,
  status: "complete" as const,
  favorite: true,
});
const page = (ids: string[]) => ({
  userId: "9007199254740993",
  threadId: "9223372036854775807",
  messages: ids.map(message),
  nextCursor: null as string | null,
});

test("message-history query accepts only an optional exact positive int64 cursor", () => {
  assert.deepEqual(conversationMessagesQuerySchema.parse({}), {});
  for (const before of ["1", "9007199254740993", "9223372036854775807"])
    assert.deepEqual(conversationMessagesQuerySchema.parse({ before }), {
      before,
    });
  for (const before of [
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e2",
    " 1",
    "1 ",
    "1\n",
    "9223372036854775808",
    "1;select 1",
    1,
    null,
    {},
    ["1"],
  ])
    assert.equal(
      conversationMessagesQuerySchema.safeParse({ before }).success,
      false,
    );
  for (const input of [
    { limit: 1000 },
    { after: "1" },
    { before: "1", userId: "2" },
  ])
    assert.equal(
      conversationMessagesQuerySchema.safeParse(input).success,
      false,
    );
});

test("message-history pages preserve bigint IDs and require strict ascending unique visible messages", () => {
  const value = page([
    "9007199254740991",
    "9007199254740992",
    "9007199254740993",
  ]);
  assert.deepEqual(conversationMessagesResponseSchema.parse(value), value);
  for (const invalid of [
    page(["10", "9"]),
    page(["9", "9"]),
    page(["9223372036854775808"]),
    page(["1", "not-an-id"]),
    page(["invalid", "2"]),
    page(["1", "9223372036854775808"]),
    { ...value, userId: "0" },
    { ...value, userId: "1\n" },
    { ...value, threadId: "01" },
    { ...value, threadId: "1\n" },
    page(["1", "2\n"]),
    { ...value, messages: [{ ...message("1"), role: "system" }] },
    { ...value, messages: [{ ...message("1"), role: "tool" }] },
    { ...value, messages: [{ ...message("1"), favorite: "true" }] },
    { ...value, messages: [{ ...message("1"), status: "pending" }] },
  ])
    assert.equal(
      conversationMessagesResponseSchema.safeParse(invalid).success,
      false,
    );
});

test("older cursor is the first message of a nonempty bounded page, including byte-limited pages", () => {
  const value = page(Array.from({ length: 100 }, (_, i) => String(i + 1)));
  assert.deepEqual(conversationMessagesResponseSchema.parse(value), value);
  assert.deepEqual(
    conversationMessagesResponseSchema.parse({ ...value, nextCursor: "1" }),
    { ...value, nextCursor: "1" },
  );
  assert.deepEqual(
    conversationMessagesResponseSchema.parse(page([])),
    page([]),
  );
  const short = { ...page(["1", "2"]), nextCursor: "1" };
  assert.deepEqual(conversationMessagesResponseSchema.parse(short), short);
  for (const invalid of [
    { ...value, nextCursor: "2" },
    { ...page([]), nextCursor: "1" },
    { ...value, messages: [...value.messages, message("101")] },
    { ...value, nextCursor: 1 },
  ])
    assert.equal(
      conversationMessagesResponseSchema.safeParse(invalid).success,
      false,
    );
});

test("message-history response is owner/thread explicit and rejects unreviewed extra fields", () => {
  const value = page(["1"]);
  for (const invalid of [
    { ...value, userId: undefined },
    { ...value, threadId: undefined },
    { ...value, nextCursor: undefined },
    { ...value, provider: "routerai" },
    { ...value, messages: [{ ...message("1"), threadId: "2" }] },
    {
      ...value,
      messages: [{ ...message("1"), metadata: { secret: "not-public" } }],
    },
  ])
    assert.equal(
      conversationMessagesResponseSchema.safeParse(invalid).success,
      false,
    );
});

test("existing generation/favorite/interruption metadata retain their read-only meaning", () => {
  const generation = {
    provider: "routerai",
    requestedModel: "synthetic/model",
    model: "synthetic/model",
    usage: { inputTokens: 1, outputTokens: 2 },
  };
  const value = {
    ...page([]),
    messages: [
      { ...message("1"), generation },
      {
        ...message("2"),
        status: "interrupted",
        generation: null,
        failureCode: "AI_CREDIT_EXHAUSTED",
      },
    ],
  };
  assert.deepEqual(conversationMessagesResponseSchema.parse(value), value);
  for (const invalid of [
    {
      ...value,
      messages: [{ ...message("1"), failureCode: "AI_CREDIT_EXHAUSTED" }],
    },
    {
      ...value,
      messages: [
        {
          ...message("1"),
          status: "interrupted",
          generation,
          failureCode: "AI_CREDIT_EXHAUSTED",
        },
      ],
    },
    {
      ...value,
      messages: [{ ...message("1"), content: "x".repeat(1024 * 1024 + 1) }],
    },
  ])
    assert.equal(
      conversationMessagesResponseSchema.safeParse(invalid).success,
      false,
    );
});

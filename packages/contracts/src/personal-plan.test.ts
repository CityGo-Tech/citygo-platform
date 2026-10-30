import assert from "node:assert/strict";
import test from "node:test";
import {
  personalPlanIdSchema,
  personalPlanItemSchema,
  createPersonalPlanItemSchema,
  updatePersonalPlanItemSchema,
  removePersonalPlanItemSchema,
  personalPlanQuerySchema,
  personalPlanPageSchema,
  personalPlanItemResultSchema,
  personalPlanRemoveResultSchema,
  personalPlanStatusSchema,
  personalPlanSummarySchema,
} from "./personal-plan.js";

const create = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceMessageId: "9007199254740993",
  title: "Обсудить работу",
  details: "Начать с собственных приоритетов.",
};
const item = {
  id: "9007199254740993",
  title: create.title,
  details: create.details,
  status: "pending" as const,
  revision: 1,
  source: {
    messageId: create.sourceMessageId,
    threadId: "2",
    role: "assistant" as const,
  },
  createdAt: "2026-10-24T12:00:00Z",
  updatedAt: "2026-10-24T15:00:00+03:00",
};

test("plan filters preserve old query and accept only the two exact statuses; summary totals are bounded and consistent", () => {
  assert.deepEqual(personalPlanQuerySchema.parse({}), {});
  assert.deepEqual(
    personalPlanQuerySchema.parse({
      before: "9007199254740993",
      status: "pending",
    }),
    { before: "9007199254740993", status: "pending" },
  );
  assert.equal(personalPlanStatusSchema.parse("completed"), "completed");
  for (const status of [
    "all",
    "Pending",
    "pending\n",
    "",
    null,
    ["pending"],
    "cancelled",
  ])
    assert.equal(personalPlanQuerySchema.safeParse({ status }).success, false);
  const summary = {
    userId: "9007199254740993",
    total: 200,
    pending: 123,
    completed: 77,
  };
  assert.deepEqual(personalPlanSummarySchema.parse(summary), summary);
  assert.equal(
    personalPlanSummarySchema.safeParse({
      userId: "1",
      total: 0,
      pending: 0,
      completed: 0,
    }).success,
    true,
  );
  for (const change of [
    { total: 201 },
    { total: 199 },
    { pending: -1 },
    { completed: 1.5 },
    { total: "200" },
    { userId: "1\n" },
    { extra: true },
  ])
    assert.equal(
      personalPlanSummarySchema.safeParse({ ...summary, ...change }).success,
      false,
    );
});

test("personal plan IDs reject alternate numeric spellings, newline selectors and overflow without throwing", () => {
  for (const value of [
    "",
    "0",
    "01",
    "-1",
    "1e3",
    "1.5",
    "1\n",
    "1\r",
    " 1",
    "1 ",
    "../admin",
    "1?owner=2",
    "a",
    "9223372036854775808",
    1,
    null,
  ]) {
    assert.doesNotThrow(() => personalPlanIdSchema.safeParse(value));
    assert.equal(personalPlanIdSchema.safeParse(value).success, false);
    assert.equal(
      createPersonalPlanItemSchema.safeParse({
        ...create,
        sourceMessageId: value,
      }).success,
      value === null,
    );
  }
  for (const value of ["1", "9007199254740993", "9223372036854775807"])
    assert.equal(personalPlanIdSchema.parse(value), value);
});

test("personal plan creation trims bounded title/details but never accepts owner, truth, XP or status authority", () => {
  assert.deepEqual(
    createPersonalPlanItemSchema.parse({
      ...create,
      title: "  Мой шаг  ",
      details: "\n  Подробности  \n",
    }),
    { ...create, title: "Мой шаг", details: "Подробности" },
  );
  assert.equal(
    createPersonalPlanItemSchema.parse({ ...create, details: "   " }).details,
    "",
  );
  const uuid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  assert.equal(
    createPersonalPlanItemSchema.parse({ ...create, operationId: uuid })
      .operationId,
    uuid.toLowerCase(),
  );
  for (const change of [
    { title: " " },
    { title: "x".repeat(121) },
    { details: "x".repeat(4001) },
    { operationId: "bad" },
    { ownerId: "2" },
    { userId: "2" },
    { status: "completed" },
    { confirmedFact: true },
    { xp: 60 },
    { model: "forged" },
    { revision: 2 },
  ])
    assert.equal(
      createPersonalPlanItemSchema.safeParse({ ...create, ...change }).success,
      false,
    );
  assert.equal(
    createPersonalPlanItemSchema.safeParse({
      ...create,
      title: "x".repeat(120),
      details: "x".repeat(4000),
    }).success,
    true,
  );
});

test("personal plan edit/remove commands require exact safe revisions and an explicit full replacement", () => {
  const update = {
    expectedRevision: 1,
    title: item.title,
    details: "",
    status: "completed",
  };
  assert.deepEqual(updatePersonalPlanItemSchema.parse(update), update);
  assert.deepEqual(
    removePersonalPlanItemSchema.parse({
      expectedRevision: Number.MAX_SAFE_INTEGER,
    }),
    { expectedRevision: Number.MAX_SAFE_INTEGER },
  );
  for (const revision of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      updatePersonalPlanItemSchema.safeParse({
        ...update,
        expectedRevision: revision,
      }).success,
      false,
    );
    assert.equal(
      removePersonalPlanItemSchema.safeParse({ expectedRevision: revision })
        .success,
      false,
    );
  }
  for (const input of [
    { expectedRevision: 1, title: "Only title" },
    { ...update, status: "cancelled" },
    { ...update, sourceMessageId: "3" },
    { ...update, operationId: create.operationId },
  ])
    assert.equal(updatePersonalPlanItemSchema.safeParse(input).success, false);
  assert.equal(
    removePersonalPlanItemSchema.safeParse({
      expectedRevision: 1,
      hardDelete: true,
    }).success,
    false,
  );
});

test("personal plan source, date, item and result envelopes are strict and canonical", () => {
  assert.deepEqual(personalPlanItemSchema.parse(item), item);
  assert.deepEqual(personalPlanItemResultSchema.parse({ userId: "1", item }), {
    userId: "1",
    item,
  });
  assert.deepEqual(
    personalPlanRemoveResultSchema.parse({
      userId: "1",
      itemId: item.id,
      removed: true,
    }),
    { userId: "1", itemId: item.id, removed: true },
  );
  for (const change of [
    { id: "1\n" },
    { revision: 0 },
    { status: "known" },
    { createdAt: "yesterday" },
    { updatedAt: "2026-02-31T00:00:00Z" },
    { truthConfirmed: true },
    { source: { ...item.source, role: "system" } },
    { source: { ...item.source, userId: "1" } },
    { source: { ...item.source, threadId: "2\n" } },
  ])
    assert.equal(
      personalPlanItemSchema.safeParse({ ...item, ...change }).success,
      false,
    );
  assert.equal(
    personalPlanItemResultSchema.safeParse({ userId: "1\n", item }).success,
    false,
  );
  assert.equal(
    personalPlanRemoveResultSchema.safeParse({
      userId: "1",
      itemId: "1",
      removed: false,
    }).success,
    false,
  );
});

test("personal plan pages bound descending bigint IDs and a full-page cursor without coercion", () => {
  assert.deepEqual(
    personalPlanPageSchema.parse({ userId: "1", items: [], nextBefore: null }),
    { userId: "1", items: [], nextBefore: null },
  );
  const items = Array.from({ length: 20 }, (_, index) => ({
    ...item,
    id: String(9007199254740993n - BigInt(index)),
  }));
  assert.equal(
    personalPlanPageSchema.safeParse({
      userId: "1",
      items,
      nextBefore: items.at(-1)!.id,
    }).success,
    true,
  );
  for (const value of [
    { items: [...items, { ...item, id: "1" }], nextBefore: null },
    { items: [item], nextBefore: item.id },
    { items: [item, item], nextBefore: null },
    { items: [...items].reverse(), nextBefore: null },
    { items, nextBefore: items[0]!.id },
    { items: [{ ...item, id: "x" }], nextBefore: null },
    { items: [], nextBefore: "1" },
  ]) {
    assert.doesNotThrow(() =>
      personalPlanPageSchema.safeParse({ userId: "1", ...value }),
    );
    assert.equal(
      personalPlanPageSchema.safeParse({ userId: "1", ...value }).success,
      false,
    );
  }
  for (const input of [
    { before: "1\n" },
    { before: ["1", "2"] },
    { userId: "2" },
    { before: "2", limit: 200 },
  ])
    assert.equal(personalPlanQuerySchema.safeParse(input).success, false);
});

test("manual plan creation explicitly chooses no source and null receipts cannot forge a message", () => {
  const manual = { ...create, sourceMessageId: null };
  assert.deepEqual(createPersonalPlanItemSchema.parse(manual), manual);
  assert.equal(
    createPersonalPlanItemSchema.safeParse({
      ...create,
      sourceMessageId: undefined,
    }).success,
    false,
  );
  assert.equal(
    personalPlanItemSchema.safeParse({ ...item, source: null }).success,
    true,
  );
  assert.equal(
    personalPlanItemSchema.safeParse({ ...item, source: {} }).success,
    false,
  );
});

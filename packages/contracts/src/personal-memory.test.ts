import assert from "node:assert/strict";
import test from "node:test";
import {
  personalMemoryIdSchema,
  personalMemoryItemSchema,
  createPersonalMemoryItemSchema,
  updatePersonalMemoryItemSchema,
  removePersonalMemoryItemSchema,
  personalMemoryListSchema,
  personalMemoryItemResultSchema,
  personalMemoryRemoveResultSchema,
} from "./personal-memory.js";

const create = {
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceMessageId: "9007199254740993",
  label: "Срок переезда",
  value: "Пока не определился со сроком.",
  confirmed: true as const,
};
const item = {
  id: "9007199254740993",
  label: create.label,
  value: create.value,
  revision: 1,
  source: {
    messageId: create.sourceMessageId,
    threadId: "2",
    role: "user" as const,
  },
  createdAt: "2026-10-25T06:00:00Z",
  updatedAt: "2026-10-25T09:00:00+03:00",
};

test("memory creation needs explicit confirmation and only permits bounded owner-chosen words", () => {
  assert.deepEqual(
    createPersonalMemoryItemSchema.parse({
      ...create,
      operationId: create.operationId.toUpperCase(),
      label: "  Срок переезда  ",
      value: "\nПока не определился со сроком.  ",
    }),
    create,
  );
  const unconfirmed = {
    operationId: create.operationId,
    sourceMessageId: create.sourceMessageId,
    label: create.label,
    value: create.value,
  };
  assert.equal(
    createPersonalMemoryItemSchema.safeParse(unconfirmed).success,
    false,
  );
  for (const changed of [
    { confirmed: false },
    { confirmed: "true" },
    { label: " " },
    { value: "\n " },
    { label: "x".repeat(81) },
    { value: "x".repeat(801) },
    { userId: "2" },
    { sourceRole: "user" },
    { state: "verified_by_model" },
    { revision: 2 },
    { operationId: "not-a-uuid" },
  ])
    assert.equal(
      createPersonalMemoryItemSchema.safeParse({ ...create, ...changed })
        .success,
      false,
    );
  assert.equal(
    createPersonalMemoryItemSchema.safeParse({
      ...create,
      label: "x".repeat(80),
      value: "x".repeat(800),
    }).success,
    true,
  );
});

test("memory selectors reject alternate spelling, separators and bigint overflow without throwing", () => {
  for (const id of [
    "0",
    "01",
    "1\n",
    "1\r",
    " 1",
    "1 ",
    "-1",
    "1e3",
    "1.0",
    "../admin",
    "1?owner=2",
    "9223372036854775808",
    1,
    null,
  ]) {
    assert.doesNotThrow(() => personalMemoryIdSchema.safeParse(id));
    assert.equal(personalMemoryIdSchema.safeParse(id).success, false);
    assert.equal(
      createPersonalMemoryItemSchema.safeParse({
        ...create,
        sourceMessageId: id,
      }).success,
      false,
    );
  }
  for (const id of ["1", "9007199254740993", "9223372036854775807"])
    assert.equal(personalMemoryIdSchema.parse(id), id);
});

test("memory corrections are complete, newly confirmed replacements with exact revisions", () => {
  const edit = {
    expectedRevision: 1,
    label: "С кем переезжаю",
    value: "С партнёром",
    confirmed: true,
  };
  assert.deepEqual(updatePersonalMemoryItemSchema.parse(edit), edit);
  for (const revision of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      updatePersonalMemoryItemSchema.safeParse({
        ...edit,
        expectedRevision: revision,
      }).success,
      false,
    );
    assert.equal(
      removePersonalMemoryItemSchema.safeParse({ expectedRevision: revision })
        .success,
      false,
    );
  }
  for (const bad of [
    { expectedRevision: 1, value: "С партнёром", confirmed: true },
    { ...edit, confirmed: false },
    { ...edit, sourceMessageId: "3" },
    { ...edit, operationId: create.operationId },
    { ...edit, userId: "2" },
  ])
    assert.equal(updatePersonalMemoryItemSchema.safeParse(bad).success, false);
  assert.deepEqual(
    removePersonalMemoryItemSchema.parse({
      expectedRevision: Number.MAX_SAFE_INTEGER,
    }),
    { expectedRevision: Number.MAX_SAFE_INTEGER },
  );
  assert.equal(
    removePersonalMemoryItemSchema.safeParse({
      expectedRevision: 1,
      hardDelete: true,
    }).success,
    false,
  );
});

test("memory output refuses hidden storage fields, invented sources and malformed timestamps", () => {
  assert.deepEqual(personalMemoryItemSchema.parse(item), item);
  assert.deepEqual(
    personalMemoryItemResultSchema.parse({ userId: "1", item }),
    { userId: "1", item },
  );
  for (const changed of [
    { revision: 0 },
    { createdAt: "yesterday" },
    { updatedAt: "2026-02-31T00:00:00Z" },
    { source: { ...item.source, role: "system" } },
    { source: { ...item.source, threadId: "2\n" } },
    { source: { ...item.source, userId: "1" } },
    { deleted_at: "2026-10-25T09:00:00Z" },
    { confirmedByModel: true },
  ])
    assert.equal(
      personalMemoryItemSchema.safeParse({ ...item, ...changed }).success,
      false,
    );
  assert.equal(
    personalMemoryItemResultSchema.safeParse({ userId: "1\n", item }).success,
    false,
  );
  assert.deepEqual(
    personalMemoryRemoveResultSchema.parse({
      userId: "1",
      itemId: item.id,
      removed: true,
    }),
    { userId: "1", itemId: item.id, removed: true },
  );
  assert.equal(
    personalMemoryRemoveResultSchema.safeParse({
      userId: "1",
      itemId: item.id,
      removed: false,
    }).success,
    false,
  );
});

test("memory is a bounded complete list with unique descending bigint IDs and no pagination authority", () => {
  assert.deepEqual(personalMemoryListSchema.parse({ userId: "1", items: [] }), {
    userId: "1",
    items: [],
  });
  const items = Array.from({ length: 20 }, (_, index) => ({
    ...item,
    id: String(9007199254740993n - BigInt(index)),
  }));
  assert.equal(
    personalMemoryListSchema.safeParse({ userId: "1", items }).success,
    true,
  );
  for (const list of [
    { userId: "1", items: [...items, { ...item, id: "1" }] },
    { userId: "1", items: [item, item] },
    { userId: "1", items: [...items].reverse() },
    { userId: "1", items: [{ ...item, id: "bad" }] },
    { userId: "1", items: [], nextBefore: "1" },
    { userId: "1", items: [], ownerId: "2" },
  ]) {
    assert.doesNotThrow(() => personalMemoryListSchema.safeParse(list));
    assert.equal(personalMemoryListSchema.safeParse(list).success, false);
  }
});

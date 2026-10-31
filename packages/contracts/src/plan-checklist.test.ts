import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  planChecklistSchema,
  savePlanChecklistSchema,
} from "./plan-checklist.js";
const entry = () => ({
  id: randomUUID(),
  title: " Проверить платежи ",
  details: " Что входит в сумму ",
  completed: false,
});
test("checklists use bounded unique explicit entries and canonical parent ownership without malformed Unicode", () => {
  const value = savePlanChecklistSchema.parse({
    expectedRevision: 1,
    entries: [entry()],
  });
  assert.equal(value.entries[0]!.title, "Проверить платежи");
  for (const entries of [
    Array.from({ length: 21 }, entry),
    [value.entries[0], value.entries[0]],
    [{ ...entry(), title: "" }],
    [{ ...entry(), details: "x".repeat(1001) }],
    [{ ...entry(), title: "bad\0text" }],
    [{ ...entry(), details: "\ud800" }],
    [{ ...entry(), completed: "false" }],
    [{ ...entry(), extra: true }],
  ])
    assert.equal(
      savePlanChecklistSchema.safeParse({ expectedRevision: 1, entries })
        .success,
      false,
    );
  for (const userId of ["0", "01", "1\n", "9223372036854775808"])
    assert.equal(
      planChecklistSchema.safeParse({
        userId,
        itemId: "2",
        revision: 1,
        entries: [],
      }).success,
      false,
    );
  assert.equal(
    savePlanChecklistSchema.safeParse({ ...value, expectedRevision: 0 })
      .success,
    false,
  );
  assert.equal(
    planChecklistSchema.safeParse({
      userId: "1",
      itemId: "9007199254740993",
      revision: 2,
      entries: value.entries,
    }).success,
    true,
  );
});

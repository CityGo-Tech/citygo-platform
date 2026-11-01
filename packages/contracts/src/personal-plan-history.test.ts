import assert from "node:assert/strict";
import test from "node:test";
import {
  personalPlanHistoryPageSchema,
  restorePersonalPlanRevisionSchema,
  personalPlanRestoreResultSchema,
  personalPlanHistoryQuerySchema,
} from "./personal-plan-history.js";
const entry = {
  revision: 2,
  title: "Шаг",
  details: "",
  status: "pending",
  checklist: [],
  initialSnapshot: false,
  recordedAt: "2026-11-01T10:00:00Z",
};
test("history contracts preserve bigint identities and bound descending revision pages", () => {
  const page = {
    userId: "1",
    itemId: "9007199254741000",
    currentRevision: 2,
    entries: [entry, { ...entry, revision: 1, initialSnapshot: true }],
    nextBefore: null,
  };
  assert.deepEqual(personalPlanHistoryPageSchema.parse(page), page);
  for (const bad of [
    { entries: [entry, entry] },
    { currentRevision: 1 },
    { nextBefore: 2 },
    { entries: Array(6).fill(entry) },
    { itemId: "01" },
    { extra: true },
  ])
    assert.equal(
      personalPlanHistoryPageSchema.safeParse({ ...page, ...bad }).success,
      false,
    );
  assert.deepEqual(
    personalPlanHistoryQuerySchema.parse({ before: "9007199254740991" }),
    { before: Number.MAX_SAFE_INTEGER },
  );
  for (const before of ["01", "0", "-1", "1.2", "9007199254740992", 1, ["2"]])
    assert.equal(
      personalPlanHistoryQuerySchema.safeParse({ before }).success,
      false,
    );
  assert.equal(
    personalPlanHistoryQuerySchema.safeParse({ search: "private" }).success,
    false,
  );
});

test("restore accepts only an older exact revision and a new noninitial saved entry", () => {
  assert.deepEqual(
    restorePersonalPlanRevisionSchema.parse({
      expectedRevision: 3,
      revision: 1,
    }),
    { expectedRevision: 3, revision: 1 },
  );
  for (const bad of [
    { expectedRevision: 3, revision: 3 },
    { expectedRevision: 3, revision: 4 },
    { expectedRevision: 0, revision: 1 },
    { expectedRevision: 3, revision: "1" },
    { expectedRevision: 3, revision: 1, title: "forged" },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1, revision: 1 },
  ])
    assert.equal(
      restorePersonalPlanRevisionSchema.safeParse(bad).success,
      false,
    );
  const result = {
    userId: "1",
    itemId: "9007199254741000",
    restoredRevision: 1,
    entry,
  };
  assert.equal(personalPlanRestoreResultSchema.safeParse(result).success, true);
  assert.equal(
    personalPlanRestoreResultSchema.safeParse({
      ...result,
      entry: { ...entry, initialSnapshot: true },
    }).success,
    false,
  );
});

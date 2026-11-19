import assert from "node:assert/strict";
import { test } from "node:test";
import {
  housingWorkspaceSchema,
  saveHousingChecklistSchema,
  saveHousingPlanSchema,
} from "./housing-workspace.js";

const requestId = "3b7a95cf-db8d-4d40-a0c0-20d73f45ae51";
const command = {
  threadId: "42",
  expectedRevision: 0,
  criteria: {
    city: "",
    commute: "  Кутузовская  ",
    situation: "oriented",
    budgetRub: null,
  },
  requestId: requestId.toUpperCase(),
};

test("an individual commute anchor can be stored with no budget or city", () => {
  assert.deepEqual(saveHousingPlanSchema.parse(command), {
    ...command,
    criteria: { ...command.criteria, commute: "Кутузовская" },
    requestId,
  });
  assert.equal(
    saveHousingPlanSchema.safeParse({ ...command, userId: "43" }).success,
    false,
  );
  assert.equal(
    saveHousingPlanSchema.safeParse({
      ...command,
      expectedRevision: 2_147_483_648,
    }).success,
    false,
  );
});

test("checklist selections are unique and bound to an existing plan revision", () => {
  const review = {
    expectedRevision: 0,
    planRevision: 1,
    selected: ["inspection", "payment"],
    paymentChecked: true,
    requestId,
  };
  assert.deepEqual(saveHousingChecklistSchema.parse(review).selected, [
    "payment",
    "inspection",
  ]);
  assert.equal(
    saveHousingChecklistSchema.safeParse({
      ...review,
      selected: ["payment", "payment"],
    }).success,
    false,
  );
  const updatedAt = "2026-11-19T00:00:00Z";
  const saved = {
    planRevision: review.planRevision,
    selected: review.selected,
    paymentChecked: review.paymentChecked,
    requestId,
    revision: 1,
    updatedAt,
  };
  assert.equal(
    housingWorkspaceSchema.safeParse({
      userId: "2",
      plan: null,
      checklist: saved,
    }).success,
    false,
  );
  assert.equal(
    housingWorkspaceSchema.safeParse({
      userId: "2",
      plan: {
        revision: 2,
        updatedAt,
        threadId: command.threadId,
        criteria: command.criteria,
        requestId,
      },
      checklist: saved,
    }).success,
    true,
  );
});

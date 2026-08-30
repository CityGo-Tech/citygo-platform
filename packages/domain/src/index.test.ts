import assert from "node:assert/strict";
import test from "node:test";

import { canTransitionQuest, transitionQuest } from "./index.js";

test("supports the happy-path quest lifecycle", () => {
  assert.equal(transitionQuest("locked", "available"), "available");
  assert.equal(transitionQuest("available", "in_progress"), "in_progress");
  assert.equal(transitionQuest("in_progress", "completed"), "completed");
});

test("completed quests cannot transition again", () => {
  assert.equal(canTransitionQuest("completed", "in_progress"), false);
  assert.throws(() => transitionQuest("completed", "in_progress"));
});

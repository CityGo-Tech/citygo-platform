import assert from "node:assert/strict";
import test from "node:test";

import { relocationStageSchema, aiProviderIdSchema } from "./index.js";
import { completionSchema, questStartSchema } from "./platform.js";

test("quest commands retain legacy payloads and validate optional persisted plan references", () => {
  assert.deepEqual(questStartSchema.parse({}), {});
  assert.deepEqual(completionSchema.parse({ confirmed: true }), {
    confirmed: true,
  });
  const plan = { id: "12", version: 2 };
  assert.deepEqual(completionSchema.parse({ confirmed: true, plan }), {
    confirmed: true,
    plan,
  });
  for (const invalid of [
    null,
    {},
    { id: "12" },
    { id: "0", version: 1 },
    { id: "12", version: 0 },
    { id: "12", version: 1.5 },
    { id: "12", version: "2" },
    { id: "12", version: 2147483648 },
  ]) {
    assert.equal(questStartSchema.safeParse({ plan: invalid }).success, false);
    assert.equal(
      completionSchema.safeParse({ confirmed: true, plan: invalid }).success,
      false,
    );
  }
});

test("provider IDs are separate from agent IDs and unavailable state", () => {
  for (const id of ["openai", "routerai", "gigachat"])
    assert.equal(aiProviderIdSchema.parse(id), id);
  for (const id of ["housing", "unconfigured", "disabled", "unknown"])
    assert.equal(aiProviderIdSchema.safeParse(id).success, false);
});

test("accepts a supported relocation stage", () => {
  assert.equal(relocationStageSchema.parse("housing"), "housing");
});

test("rejects an unknown relocation stage", () => {
  assert.equal(relocationStageSchema.safeParse("unknown").success, false);
});

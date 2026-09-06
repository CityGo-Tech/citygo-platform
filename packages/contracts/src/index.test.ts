import assert from "node:assert/strict";
import test from "node:test";

import { relocationStageSchema, aiProviderIdSchema } from "./index.js";

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

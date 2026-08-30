import assert from "node:assert/strict";
import test from "node:test";

import { relocationStageSchema } from "./index.js";

test("accepts a supported relocation stage", () => {
  assert.equal(relocationStageSchema.parse("housing"), "housing");
});

test("rejects an unknown relocation stage", () => {
  assert.equal(relocationStageSchema.safeParse("unknown").success, false);
});

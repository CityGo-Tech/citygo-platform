import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as facade from "./housing.js";
import * as v1 from "./housing-v1.js";

test("explicit v1 schemas/helper remain attached to the frozen v1 module", () => {
  assert.equal(
    facade.r1HousingBriefCreateCommandV1Schema,
    v1.r1HousingBriefCreateCommandSchema,
  );
  assert.equal(
    facade.r1HousingAnswerCommandV1Schema,
    v1.r1HousingAnswerCommandSchema,
  );
  assert.equal(
    facade.r1HousingBriefDraftV1Schema,
    v1.r1HousingBriefDraftSchema,
  );
  assert.equal(facade.r1HousingIdV1Schema, v1.r1HousingIdSchema);
  assert.equal(facade.r1HousingRevisionV1Schema, v1.r1HousingRevisionSchema);
  assert.equal(facade.createR1HousingAnswersV1, v1.createR1HousingAnswers);
});

test("v1 validator source is pinned, not merely its positive JSON fixtures", async () => {
  // Stronger regression guard than positive fixtures: weakening a validator or
  // changing a nested normalization rule changes this digest as well. Do not
  // update it to introduce v2; add a new module and leave v1 intact. Even a
  // comment/format change requires explicit compatibility review of this pin.
  const source = await readFile(
    new URL("./housing-v1.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex"),
    "09a8c8fb0f7c50ea9e5fbf44fd6b92fe9a720de544f3fd19093ebf106e6ace53",
  );
});

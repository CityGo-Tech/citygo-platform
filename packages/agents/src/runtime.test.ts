import test from "node:test";
import assert from "node:assert/strict";
import { routeAgent } from "./runtime.js";
test("explicit specialties route and housing near work stays housing", () => {
  assert.equal(
    routeAgent("Помоги составить резюме", "housing").to,
    "resume-builder",
  );
  assert.equal(
    routeAgent("Ищу квартиру рядом с работой", "housing").to,
    "housing",
  );
  assert.equal(routeAgent("Нужен живой риелтор", "housing").human, true);
});

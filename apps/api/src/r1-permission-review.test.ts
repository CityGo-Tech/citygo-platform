import test from "node:test";
import { permissionReviewScenarios } from "./r1-permission-review.fixture.js";

for (const scenario of permissionReviewScenarios)
  test("review regression: " + scenario.name, (t) => scenario.run(t));

import assert from "node:assert/strict";
import test from "node:test";

import { healthResponseSchema } from "@citygo/contracts";

import { buildApp } from "./app.js";

test("GET /health reports API readiness", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.equal(healthResponseSchema.parse(response.json()).status, "ok");

  await app.close();
});

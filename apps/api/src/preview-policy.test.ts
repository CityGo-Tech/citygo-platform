import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";

const publicConfig = {
  ROUTERAI_MODEL: "synthetic/model",
  ROUTERAI_UPSTREAM: "synthetic-upstream",
  ROUTERAI_COUNTRY: "us",
  ROUTERAI_DATA_NOTICE:
    "Synthetic operator notice, not approved for real users.",
};

function preview(overrides: Record<string, string | undefined> = {}) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./preview-policy.ts", import.meta.url)),
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        ...publicConfig,
        NODE_ENV: "production",
        LLM_PROVIDER: "routerai",
        DATABASE_URL: "invalid-secret-database-canary",
        ROUTERAI_API_KEY: "secret-router-canary",
        ROUTERAI_PRODUCTION_POLICY_ID: "invalid-prior-approval-canary",
        OPENAI_API_KEY: "secret-openai-canary",
        ...overrides,
      },
    },
  );
}

test("policy preview ignores inherited credentials, approvals and runtime configuration", () => {
  const result = preview();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    JSON.parse(result.stdout),
    createAiPolicy(readConfig(publicConfig), {
      name: "routerai",
      model: publicConfig.ROUTERAI_MODEL,
    }),
  );
  assert.doesNotMatch(result.stdout, /canary/);
});

test("policy preview rejects missing or invalid public metadata without printing inputs", () => {
  for (const overrides of [
    { ROUTERAI_MODEL: "" },
    { ROUTERAI_UPSTREAM: "" },
    { ROUTERAI_DATA_NOTICE: "" },
    { ROUTERAI_DATA_NOTICE: "invalid-notice-canary".repeat(300) },
  ]) {
    const result = preview(overrides);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid values are hidden/);
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

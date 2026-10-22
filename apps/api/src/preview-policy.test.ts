import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

test("owner-approved CN public snapshot is pinned explicitly and preview does not inherit activation or secrets", () => {
  const fields = JSON.parse(
    readFileSync(
      new URL(
        "../../../docs/operations/routerai-pro-cn-policy.approved.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, string>;
  assert.deepEqual(Object.keys(fields).sort(), [
    "ROUTERAI_COUNTRY",
    "ROUTERAI_DATA_NOTICE",
    "ROUTERAI_MODEL",
    "ROUTERAI_PRODUCTION_POLICY_ID",
    "ROUTERAI_UPSTREAM",
  ]);
  // Independently recorded after the owner's approval, never derived at startup.
  const approvedId =
    "6308c24a8c3eb9e0a2d5363ab7ec6f62dbf57ce6b7ad9ee31cfd2ca3b05b7615";
  assert.equal(fields.ROUTERAI_PRODUCTION_POLICY_ID, approvedId);
  assert.equal(fields.ROUTERAI_COUNTRY, "cn");
  assert.equal(fields.ROUTERAI_UPSTREAM, "deepseek");
  assert.equal(fields.ROUTERAI_MODEL, "deepseek/deepseek-v4-pro-0813");
  const result = preview(fields);
  assert.equal(result.status, 0, result.stderr);
  const policy = JSON.parse(result.stdout);
  assert.equal(policy.id, approvedId);
  assert.equal(policy.version, "ai-recipient-v2");
  assert.equal(policy.provider, "routerai");
  assert.equal(policy.recipient, "RouterAI");
  assert.ok(policy.data.endsWith(fields.ROUTERAI_DATA_NOTICE));
  assert.doesNotMatch(result.stdout + result.stderr, /canary/);
  for (const change of [
    { ROUTERAI_COUNTRY: "us" },
    { ROUTERAI_MODEL: "deepseek/deepseek-v4-flash" },
    { ROUTERAI_DATA_NOTICE: "Changed or removed notice" },
  ]) {
    const changed = createAiPolicy(readConfig({ ...fields, ...change }), {
      name: "routerai",
      model: change.ROUTERAI_MODEL ?? fields.ROUTERAI_MODEL!,
    })!;
    assert.notEqual(changed.id, approvedId);
  }
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

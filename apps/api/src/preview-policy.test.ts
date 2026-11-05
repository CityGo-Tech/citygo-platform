import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readConfig } from "@citygo/config";
import { createAssistantModes } from "./ai-modes.js";
import { createAiPolicy } from "./ai-policy.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../deploy/fixtures/postpay-memory-profile.fixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, string>;
const system = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR)$/i.test(
      key,
    ),
  ),
);
const publicFields = Object.fromEntries(
  [
    "ROUTERAI_MODEL",
    "ROUTERAI_UPSTREAM",
    "ROUTERAI_COUNTRY",
    "ROUTERAI_DATA_NOTICE",
    "AI_ASSISTANT_MODES",
    "AI_MODES_DATA_NOTICE",
    "AI_MAXIMUM_REASONING_EFFORT",
    "GIGACHAT_MODEL",
    "GIGACHAT_SCOPE",
  ].map((key) => [key, fixture[key]!]),
);

const publicConfig = {
  ROUTERAI_MODEL: "synthetic/model",
  ROUTERAI_UPSTREAM: "synthetic-upstream",
  ROUTERAI_COUNTRY: "us",
  ROUTERAI_DATA_NOTICE:
    "Synthetic operator notice, not approved for real users.",
};
function legacyPreview(overrides: Record<string, string | undefined> = {}) {
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
      windowsHide: true,
      env: {
        ...system,
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
  const result = legacyPreview();
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
  const approvedId =
    "6308c24a8c3eb9e0a2d5363ab7ec6f62dbf57ce6b7ad9ee31cfd2ca3b05b7615";
  assert.equal(fields.ROUTERAI_PRODUCTION_POLICY_ID, approvedId);
  assert.equal(fields.ROUTERAI_COUNTRY, "cn");
  assert.equal(fields.ROUTERAI_UPSTREAM, "deepseek");
  assert.equal(fields.ROUTERAI_MODEL, "deepseek/deepseek-v4-pro-0813");
  const result = legacyPreview(fields);
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
    const result = legacyPreview(overrides);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid values are hidden/);
    assert.doesNotMatch(result.stderr, /canary/);
  }
});

function preview(settings: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/api/src/preview-policy.ts"],
    {
      cwd: root,
      env: {
        ...system,
        ...publicFields,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://127.0.0.1:1/ignored-unreachable",
        ROUTERAI_API_KEY: "synthetic-ignored-provider-key",
        GIGACHAT_CREDENTIALS: "synthetic-ignored-provider-key",
        AI_CUSTOMER_BILLING_MODE: "ignored-private-control",
        ...settings,
      },
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    },
  );
}

test("public preview reproduces the new memory policy without credentials, database or spending settings", () => {
  const config = readConfig({
    ...fixture,
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    WEB_ORIGIN: "https://pilot.example.test",
    GIGACHAT_CA_BUNDLE_FILE: undefined,
  });
  const expected = createAssistantModes(config)!.policy;
  const result = preview({ AI_CONTEXT_STRATEGY: "model_window_memory_v1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.doesNotMatch(
    result.stdout,
    /ignored|postgresql|synthetic-client|Server listening/,
  );
});

test("legacy public preview identities remain exact and invalid memory routes fail closed", () => {
  const expected = createAssistantModes(readConfig(publicFields))!.policy;
  for (const AI_CONTEXT_STRATEGY of [undefined, "legacy"]) {
    const result = preview({ AI_CONTEXT_STRATEGY });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  for (const settings of [
    { AI_CONTEXT_STRATEGY: "unlimited" },
    {
      AI_CONTEXT_STRATEGY: "model_window_memory_v1",
      AI_ASSISTANT_MODES: "disabled",
    },
    {
      AI_CONTEXT_STRATEGY: "model_window_memory_v1",
      GIGACHAT_MODEL: "GigaChat-2-Max",
    },
    {
      AI_CONTEXT_STRATEGY: "model_window_memory_v1",
      GIGACHAT_SCOPE: "GIGACHAT_API_B2B",
    },
  ]) {
    const result = preview(settings);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /ignored|postgresql|ECONNREFUSED/);
  }
});

test("native production preview is explicit, public-only and preserves disabled policy identity", () => {
  const common = {
    ...fixture,
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    WEB_ORIGIN: "https://pilot.example.test",
    GIGACHAT_CA_BUNDLE_FILE: undefined,
  };
  const expected = createAssistantModes(
    readConfig({
      ...common,
      AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
    }),
  )!.policy;
  const actual = preview({
    AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
    LLM_PROVIDER: "routerai",
    AI_MODES_PRODUCTION_POLICY_ID: "ignored-private-approval-canary",
  });
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stderr, "");
  assert.deepEqual(JSON.parse(actual.stdout), expected);
  assert.equal(expected.version, "ai-assistant-modes-web-search-postpay-v1");
  assert.doesNotMatch(
    actual.stdout,
    /ignored|postgresql|canary|Server listening/,
  );
  const disabled = preview({
    AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    AI_MAXIMUM_WEB_SEARCH: "disabled",
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.deepEqual(
    JSON.parse(disabled.stdout),
    createAssistantModes(
      readConfig({
        ...common,
        AI_MAXIMUM_WEB_SEARCH: "disabled",
      }),
    )!.policy,
  );
  assert.notEqual(JSON.parse(disabled.stdout).id, expected.id);
});

test("public preview refuses candidate, test-only and unknown search capabilities", () => {
  for (const capability of [
    "routerai_native_candidate_v1",
    "routerai_native_postpay_test_v1",
    "inferred-native-capability-canary",
  ]) {
    const result = preview({
      AI_CONTEXT_STRATEGY: "model_window_memory_v1",
      AI_MAXIMUM_WEB_SEARCH: capability,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid values are hidden/);
    assert.doesNotMatch(
      result.stderr,
      /canary|ignored|postgresql|ECONNREFUSED/,
    );
  }
  const missingMemory = preview({
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
  });
  assert.equal(missingMemory.status, 1);
  assert.equal(missingMemory.stdout, "");
});

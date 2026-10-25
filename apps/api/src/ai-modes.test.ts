import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { aiModesSchema, serviceAiProcessingSchema } from "@citygo/contracts";
import { createAssistantModes } from "./ai-modes.js";

const settings = {
  NODE_ENV: "test",
  DATABASE_URL: "pglite://:memory:",
  LLM_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "synthetic-router-key",
  AI_ASSISTANT_MODES: "enabled",
  AI_MODES_DATA_NOTICE:
    "Synthetic mode recipients, not an approved production notice.",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
};
test("server catalog contains only the three product labels and uses two independent exact RouterAI profiles", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const modes = createAssistantModes(readConfig(settings))!;
  const catalog = aiModesSchema.parse(modes.modeCatalog());
  assert.deepEqual(catalog.options, [
    { id: "maximum", label: "Максимум", available: true },
    { id: "balanced", label: "Баланс", available: true },
    { id: "minimum", label: "Минимум", available: false },
  ]);
  assert.doesNotMatch(
    JSON.stringify(catalog),
    /openai|deepseek|gigachat|routerai|synthetic-router-key/i,
  );
  assert.doesNotMatch(
    modes.policy.data,
    /gpt-6\.1-sol|deepseek-v4-pro|GigaChat-3-Ultra/,
  );
  serviceAiProcessingSchema.parse(modes.policy);
  const routing = {
    provider: "routerai" as const,
    policyId: modes.policy.id,
    revision: 1,
  };
  const maximum = modes.resolve(routing, {
    aiMode: "maximum",
    aiModeCatalogId: catalog.catalogId,
  });
  const balanced = modes.resolve(routing, {});
  assert.equal(maximum.provider.name, "routerai");
  assert.equal(maximum.provider.model, "openai/gpt-6.1-sol");
  assert.equal(maximum.upstream, "openai");
  assert.equal(maximum.country, "us");
  assert.equal(balanced.provider.model, "deepseek/deepseek-v4-pro-0813");
  assert.equal(balanced.upstream, "deepseek");
  assert.equal(balanced.country, "cn");
  assert.notEqual(maximum.provider, balanced.provider);
  assert.notEqual(maximum.execution.key, balanced.execution.key);
  assert.throws(() => modes.resolve(routing, { aiMode: "minimum" }), {
    code: "AI_MODE_UNAVAILABLE",
  });
  assert.throws(
    () =>
      modes.resolve(routing, {
        aiMode: "maximum",
        aiModeCatalogId: "0".repeat(64),
      }),
    { code: "AI_MODE_CHANGED" },
  );
  assert.equal(fetch.mock.callCount(), 0);
});
test("mode production approval binds the entire public bundle, never a key or the old DeepSeek-only approval", () => {
  const config = readConfig({
    ...settings,
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://localhost/not-used",
    WEB_ORIGIN: "https://citygo.example",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  });
  const unapproved = createAssistantModes(config)!;
  assert.ok(unapproved.modeCatalog().options.every((mode) => !mode.available));
  const approved = createAssistantModes({
    ...config,
    AI_MODES_PRODUCTION_POLICY_ID: unapproved.policy.id,
  })!;
  assert.equal(approved.modeCatalog().options[0]!.available, true);
  assert.equal(approved.modeCatalog().options[1]!.available, true);
  assert.equal(approved.modeCatalog().options[2]!.available, false);
  assert.equal(
    createAssistantModes({
      ...config,
      AI_MODES_PRODUCTION_POLICY_ID: "a".repeat(64),
    })!.productionApproved,
    false,
  );
  assert.equal(
    createAssistantModes({
      ...config,
      AI_MODES_DATA_NOTICE: "changed",
      AI_MODES_PRODUCTION_POLICY_ID: unapproved.policy.id,
    })!.productionApproved,
    false,
  );
  assert.equal(
    createAssistantModes({ ...config, ROUTERAI_API_KEY: "changed-secret" })!
      .policy.id,
    unapproved.policy.id,
  );
  assert.doesNotMatch(
    JSON.stringify(unapproved.policy),
    /synthetic-router-key/,
  );
  const disabled = createAssistantModes({
    ...config,
    LLM_PROVIDER: "disabled",
    AI_MODES_PRODUCTION_POLICY_ID: unapproved.policy.id,
  })!;
  assert.ok(disabled.modeCatalog().options.every((mode) => !mode.available));
});
test("the legacy profile is unchanged and a catalog changes with execution limits without changing the recipient grant", () => {
  assert.equal(createAssistantModes(readConfig({ NODE_ENV: "test" })), null);
  const original = createAssistantModes(readConfig(settings))!;
  const limits = createAssistantModes(
    readConfig({ ...settings, ROUTERAI_MAX_OUTPUT_TOKENS: "8000" }),
  )!;
  assert.equal(original.policy.id, limits.policy.id);
  assert.notEqual(original.catalogId, limits.catalogId);
  const effort = createAssistantModes(
    readConfig({ ...settings, AI_MAXIMUM_REASONING_EFFORT: "high" }),
  )!;
  assert.equal(original.policy.id, effort.policy.id);
  assert.notEqual(original.catalogId, effort.catalogId);
  assert.notEqual(
    original.routes[0]!.execution.key,
    effort.routes[0]!.execution.key,
  );
  const other = createAssistantModes(
    readConfig({ ...settings, GIGACHAT_SCOPE: "GIGACHAT_API_B2B" }),
  )!;
  assert.notEqual(original.policy.id, other.policy.id);
});

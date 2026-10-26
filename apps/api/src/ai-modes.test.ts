import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
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
const fixedSettings = {
  ...settings,
  AI_MINIMUM_FIXED_FEE: "enabled",
  GIGACHAT_MODEL: "GigaChat-3-Ultra",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  GIGACHAT_CREDENTIALS: Buffer.from(
    "synthetic-client:synthetic-secret",
  ).toString("base64"),
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

test("fixed Minimum publishes only its product price and freezes the billing rule separately from account identity", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const modes = createAssistantModes(readConfig(fixedSettings))!;
  const route = modes.resolve(
    { provider: "routerai", policyId: modes.policy.id, revision: 1 },
    { aiMode: "minimum", aiModeCatalogId: modes.catalogId },
  );
  assert.equal(route.provider.name, "gigachat");
  assert.equal(route.model, "GigaChat-3-Ultra");
  assert.deepEqual(modes.modeCatalog().options[2], {
    id: "minimum",
    label: "Минимум",
    available: true,
    price: { kind: "fixed", currency: "RUB", amountMicros: 3_000_000 },
  });
  const pricingId = createHash("sha256")
    .update(
      JSON.stringify({
        version: "citygo-gigachat-flat3-success-v1",
        feeMicros: 3_000_000,
        holdMicros: 5_000_000,
        operatorCostMicros: 0,
        model: "GigaChat-3-Ultra",
        scope: "GIGACHAT_API_PERS",
      }),
    )
    .digest("hex");
  assert.deepEqual(route.fixedFee, {
    pricingId,
    accountRef: createHash("sha256")
      .update("GIGACHAT_API_PERS\0synthetic-client")
      .digest("hex"),
    scope: "GIGACHAT_API_PERS",
    leaseMs: 90_000,
  });
  const publicData = JSON.stringify({
    policy: modes.policy,
    catalog: modes.modeCatalog(),
    execution: route.execution,
  });
  assert.ok(!publicData.includes(route.fixedFee!.accountRef));
  assert.ok(!publicData.includes(fixedSettings.GIGACHAT_CREDENTIALS));
  const rotated = createAssistantModes(
    readConfig({
      ...fixedSettings,
      GIGACHAT_CREDENTIALS: Buffer.from(
        "synthetic-client:rotated-secret",
      ).toString("base64"),
    }),
  )!;
  assert.equal(rotated.policy.id, modes.policy.id);
  assert.equal(rotated.catalogId, modes.catalogId);
  assert.equal(rotated.routes[2]!.execution.key, route.execution.key);
  assert.equal(rotated.routes[2]!.fixedFee!.pricingId, pricingId);
  assert.equal(
    rotated.routes[2]!.fixedFee!.accountRef,
    route.fixedFee!.accountRef,
  );
  const anotherAccount = createAssistantModes(
    readConfig({
      ...fixedSettings,
      GIGACHAT_CREDENTIALS: Buffer.from(
        "other-client:synthetic-secret",
      ).toString("base64"),
    }),
  )!;
  assert.notEqual(
    anotherAccount.routes[2]!.fixedFee!.accountRef,
    route.fixedFee!.accountRef,
  );
  assert.equal(anotherAccount.policy.id, modes.policy.id);
  assert.equal(anotherAccount.catalogId, modes.catalogId);
  assert.doesNotMatch(publicData, /synthetic-client|synthetic-secret/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("fixed Minimum requires every explicit billing and account gate; legacy free mode gains no price", () => {
  for (const fields of [
    { AI_MINIMUM_FIXED_FEE: "disabled" },
    { AI_CREDIT_MODE: "disabled", AI_CREDIT_RESERVATION_MODE: "full" },
    { AI_CREDIT_MODE: "routerai_at_cost", AI_CREDIT_RESERVATION_MODE: "full" },
    { AI_CREDIT_RESERVATION_MODE: "full" },
    { GIGACHAT_MODEL: "GigaChat-2" },
    { GIGACHAT_MODEL: "" },
    { GIGACHAT_SCOPE: "GIGACHAT_API_B2B" },
    { GIGACHAT_SCOPE: "" },
    { GIGACHAT_CREDENTIALS: "" },
    { GIGACHAT_CREDENTIALS: "not a base64 key" },
    {
      GIGACHAT_CREDENTIALS: Buffer.from("no-client-delimiter").toString(
        "base64",
      ),
    },
    { GIGACHAT_CREDENTIALS: Buffer.from(":empty-client").toString("base64") },
    { GIGACHAT_CREDENTIALS: Buffer.from("client:").toString("base64") },
    {
      GIGACHAT_CREDENTIALS: Buffer.from("bad client:secret").toString("base64"),
    },
    { GIGACHAT_CREDENTIALS: Buffer.from("клиент:secret").toString("base64") },
    { LLM_PROVIDER: "disabled" },
  ]) {
    const modes = createAssistantModes(
      readConfig({ ...fixedSettings, ...fields }),
    )!;
    assert.equal(modes.routes[2]!.provider, undefined);
    assert.equal(modes.routes[2]!.fixedFee, undefined);
    assert.equal(modes.modeCatalog().options[2]!.price, undefined);
  }
  const free = createAssistantModes(
    readConfig({
      ...fixedSettings,
      AI_MINIMUM_FIXED_FEE: "disabled",
      AI_CREDIT_MODE: "disabled",
      AI_CREDIT_RESERVATION_MODE: "full",
    }),
  )!;
  assert.equal(free.modeCatalog().options[2]!.available, true);
  assert.equal(free.modeCatalog().options[2]!.price, undefined);
  assert.equal(free.routes[2]!.fixedFee, undefined);
  const flagOff = createAssistantModes(
    readConfig({ ...fixedSettings, AI_MINIMUM_FIXED_FEE: "disabled" }),
  )!;
  const fixed = createAssistantModes(readConfig(fixedSettings))!;
  assert.equal(free.policy.id, fixed.policy.id);
  assert.notEqual(
    flagOff.routes[2]!.execution.key,
    fixed.routes[2]!.execution.key,
  );
  assert.notEqual(flagOff.catalogId, fixed.catalogId);
  assert.deepEqual(flagOff.routes[0]!.execution, fixed.routes[0]!.execution);
  assert.deepEqual(flagOff.routes[1]!.execution, fixed.routes[1]!.execution);
});

test("production fixed Minimum still requires the exact approved recipient bundle", () => {
  const config = readConfig({
    ...fixedSettings,
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://localhost/not-used",
    WEB_ORIGIN: "https://citygo.example",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  });
  const pending = createAssistantModes(config)!;
  assert.equal(pending.routes[2]!.fixedFee, undefined);
  assert.equal(pending.modeCatalog().options[2]!.available, false);
  const approved = createAssistantModes({
    ...config,
    AI_MODES_PRODUCTION_POLICY_ID: pending.policy.id,
  })!;
  assert.equal(approved.modeCatalog().options[2]!.available, true);
  assert.ok(approved.routes[2]!.fixedFee);
  for (const change of [
    { AI_MODES_PRODUCTION_POLICY_ID: "b".repeat(64) },
    { AI_MODES_DATA_NOTICE: "changed recipients" },
    { AI_MINIMUM_FIXED_FEE: "disabled" as const },
  ]) {
    const blocked = createAssistantModes({
      ...config,
      AI_MODES_PRODUCTION_POLICY_ID: pending.policy.id,
      ...change,
    })!;
    assert.equal(blocked.routes[2]!.provider, undefined);
    assert.equal(blocked.routes[2]!.fixedFee, undefined);
  }
});

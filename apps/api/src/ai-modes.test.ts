import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readConfig } from "@citygo/config";
import { aiModesSchema, serviceAiProcessingSchema } from "@citygo/contracts";
import { createAssistantModes } from "./ai-modes.js";
import { createAiPolicy } from "./ai-policy.js";
import { createAiExecution } from "./ai-execution.js";

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

test("source-bound memory gets new consent and execution identities without changing routes, prices or legacy approvals", () => {
  const settings = {
    ...fixedSettings,
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    LLM_MAX_INPUT_BYTES: "65536",
    ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
  };
  const legacy = createAssistantModes(readConfig(settings))!;
  const memory = createAssistantModes(
    readConfig({
      ...settings,
      LLM_MAX_INPUT_BYTES: "8388608",
      AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    }),
  )!;
  assert.equal(legacy.policy.version, "ai-assistant-modes-v1");
  assert.equal(memory.policy.version, "ai-assistant-modes-memory-v1");
  assert.notEqual(memory.policy.id, legacy.policy.id);
  assert.notEqual(memory.catalogId, legacy.catalogId);
  assert.deepEqual(memory.modeCatalog().options, legacy.modeCatalog().options);
  assert.match(memory.policy.data, /ста завершённых пар/);
  assert.match(
    memory.policy.data,
    /более ранних сообщений пользователя того же диалога/,
  );
  assert.equal(memory.legacyBalancedCompatibility, undefined);
  for (const [index, route] of memory.routes.entries()) {
    const before = legacy.routes[index]!;
    assert.equal(route.id, before.id);
    assert.equal(route.model, before.model);
    assert.equal(route.providerName, before.providerName);
    assert.equal(
      route.execution.maxOutputTokens,
      before.execution.maxOutputTokens,
    );
    assert.deepEqual(route.fixedFee, before.fixedFee);
    assert.notEqual(route.policy.id, before.policy.id);
    assert.notEqual(route.execution.key, before.execution.key);
  }
  assert.deepEqual(
    createAssistantModes(readConfig(settings))!.routes.map(
      ({ execution }) => execution,
    ),
    legacy.routes.map(({ execution }) => execution),
  );
});
test("retained consent selects only the exact bootstrap Balanced route and requires one real opt-in for other modes", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const config = readConfig({
    ...fixedSettings,
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "cn",
    LLM_MAX_INPUT_BYTES: "8192",
    ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
    ROUTERAI_DATA_NOTICE: "Synthetic original recipient notice.",
  });
  const modes = createAssistantModes(config)!;
  const oldPolicy = createAiPolicy(config, {
    name: "routerai",
    model: "deepseek/deepseek-v4-pro-0813",
  })!;
  const oldExecution = createAiExecution(config, oldPolicy);
  assert.deepEqual(modes.legacyBalancedCompatibility, {
    routingPolicyId: modes.policy.id,
    policy: oldPolicy,
    execution: oldExecution,
  });
  const legacy = { currentAiConsentRequired: true };
  const oldCatalog = modes.modeCatalog(legacy);
  assert.notEqual(oldCatalog.catalogId, modes.catalogId);
  assert.deepEqual(
    oldCatalog.options.map(({ id, available, consentRequired }) => ({
      id,
      available,
      ...(consentRequired ? { consentRequired } : {}),
    })),
    [
      { id: "maximum", available: true, consentRequired: true },
      { id: "balanced", available: true },
      { id: "minimum", available: true, consentRequired: true },
    ],
  );
  const routing = {
    provider: "routerai" as const,
    policyId: modes.policy.id,
    revision: 2,
  };
  const chosen = modes.resolve(
    routing,
    { aiMode: "balanced", aiModeCatalogId: oldCatalog.catalogId },
    legacy,
  );
  assert.deepEqual(chosen.policy, oldPolicy);
  assert.deepEqual(chosen.execution, oldExecution);
  assert.equal(chosen.catalogId, oldCatalog.catalogId);
  assert.notEqual(
    chosen.execution.key,
    modes.resolve(routing, {}).execution.key,
  );
  for (const aiMode of ["maximum", "minimum"] as const)
    assert.throws(
      () =>
        modes.resolve(
          routing,
          { aiMode, aiModeCatalogId: oldCatalog.catalogId },
          legacy,
        ),
      { code: "AI_MODES_CONSENT_REQUIRED", statusCode: 403 },
    );
  // Neither a stale old tab nor an unconfirmed tab may reinterpret its choice.
  assert.throws(
    () =>
      modes.resolve(routing, {
        aiMode: "balanced",
        aiModeCatalogId: oldCatalog.catalogId,
      }),
    { code: "AI_MODE_CHANGED" },
  );
  assert.throws(
    () =>
      modes.resolve(
        routing,
        { aiMode: "balanced", aiModeCatalogId: modes.catalogId },
        legacy,
      ),
    { code: "AI_MODE_CHANGED" },
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("legacy compatibility cannot be inferred from a changed bootstrap route or the new production bundle approval", () => {
  const original = {
    ...settings,
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "cn",
    ROUTERAI_DATA_NOTICE: "Synthetic original recipient notice.",
    LLM_MAX_INPUT_BYTES: "8192",
    ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
  };
  for (const fields of [
    { ROUTERAI_MODEL: "other-model" },
    { ROUTERAI_UPSTREAM: "other-upstream" },
    { ROUTERAI_COUNTRY: "us" },
    {
      LLM_PROVIDER: "openai",
      AI_CREDIT_MODE: "disabled",
      AI_CREDIT_RESERVATION_MODE: "full",
    },
    { ROUTERAI_DATA_NOTICE: "" },
    { LLM_MAX_INPUT_BYTES: "16384" },
    { ROUTERAI_MAX_OUTPUT_TOKENS: "8000" },
    { AI_CREDIT_RESERVATION_MODE: "full" },
  ]) {
    const modes = createAssistantModes(readConfig({ ...original, ...fields }))!;
    assert.equal(modes.legacyBalancedCompatibility, undefined);
    assert.equal(
      modes.modeCatalog({ currentAiConsentRequired: true }).options[1]!
        .available,
      false,
    );
  }
  const production = readConfig({
    ...original,
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://localhost/not-used",
    WEB_ORIGIN: "https://citygo.example",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  });
  const draft = createAssistantModes(production)!;
  const currentApprovedOnly = createAssistantModes({
    ...production,
    AI_MODES_PRODUCTION_POLICY_ID: draft.policy.id,
  })!;
  assert.equal(currentApprovedOnly.productionApproved, true);
  assert.equal(currentApprovedOnly.legacyBalancedCompatibility, undefined);
});
test("server catalog contains only the three product labels and uses two independent exact RouterAI profiles", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const modes = createAssistantModes(readConfig(settings))!;
  const catalog = aiModesSchema.parse(modes.modeCatalog());
  // Keep the exact strict wire shape and omitted-call route used by shipped APKs.
  assert.equal(catalog.defaultMode, "balanced");
  assert.deepEqual(Object.keys(catalog).sort(), [
    "catalogId",
    "defaultMode",
    "options",
  ]);
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

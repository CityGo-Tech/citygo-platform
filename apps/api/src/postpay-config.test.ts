import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readConfig, validateCreditReservationConfig } from "@citygo/config";
import { aiModeIds, aiModesSchema } from "@citygo/contracts";
import { createAssistantModes } from "./ai-modes.js";

const settings = {
  NODE_ENV: "test",
  DATABASE_URL: "pglite://:memory:",
  LLM_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "synthetic-postpay-router-key",
  ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
  ROUTERAI_UPSTREAM: "deepseek",
  ROUTERAI_COUNTRY: "cn",
  ROUTERAI_DATA_NOTICE: "Synthetic retained recipient notice.",
  AI_ASSISTANT_MODES: "enabled",
  AI_MODES_DATA_NOTICE: "Synthetic mode recipients; no production approval.",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  AI_MINIMUM_FIXED_FEE: "enabled",
  GIGACHAT_MODEL: "GigaChat-3-Ultra",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  GIGACHAT_CREDENTIALS: Buffer.from(
    "postpay-client:synthetic-minimum-secret-one",
  ).toString("base64"),
};
type Config = ReturnType<typeof readConfig>;
type Modes = NonNullable<ReturnType<typeof createAssistantModes>>;
function config(overrides: NodeJS.ProcessEnv = {}) {
  return readConfig({ ...settings, ...overrides });
}
function modes(value: Config) {
  const result = createAssistantModes(value);
  assert.ok(result);
  return result;
}
function routing(value: Modes) {
  return {
    provider: "routerai" as const,
    policyId: value.policy.id,
    revision: 1,
  };
}
function snapshot(value: Modes) {
  return {
    policy: value.policy,
    catalog: value.modeCatalog(),
    routes: value.routes.map((route) => ({
      id: route.id,
      model: route.model,
      upstream: route.upstream,
      country: route.country,
      execution: route.execution,
      fixedFee: route.fixedFee,
    })),
  };
}
function forbidNetwork(t: TestContext) {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Network forbidden in postpay configuration tests");
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
}

test("omitted postpay opt-in preserves explicit legacy configuration, catalogs, execution and flat-three identity", (t) => {
  forbidNetwork(t);
  assert.equal(readConfig({}).AI_CUSTOMER_BILLING_MODE, "legacy");
  const omitted = config();
  const explicit = config({ AI_CUSTOMER_BILLING_MODE: "legacy" });
  assert.deepEqual(omitted, explicit);
  assert.deepEqual(snapshot(modes(omitted)), snapshot(modes(explicit)));
  assert.equal(omitted.AI_REQUEST_COST_LIMIT_MODE, "operator_ceiling");
  assert.equal(omitted.YOOKASSA_MODE, "disabled");
  assert.equal(omitted.PHONE_VERIFICATION_MODE, "disabled");
});

test("postpay environment opt-in rejects incompatible credit, reservation, cost-limit, mode and provider combinations", (t) => {
  forbidNetwork(t);
  const opted = { ...settings, AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1" };
  assert.equal(readConfig(opted).AI_CUSTOMER_BILLING_MODE, "postpay_actual_v1");
  const incompatible: NodeJS.ProcessEnv[] = [
    { AI_CREDIT_MODE: "disabled" },
    { AI_CREDIT_MODE: "routerai_at_cost" },
    { AI_CREDIT_RESERVATION_MODE: "full" },
    { AI_REQUEST_COST_LIMIT_MODE: "user_balance" },
    { AI_ASSISTANT_MODES: "disabled" },
    { LLM_PROVIDER: "openai" },
    { LLM_PROVIDER: "gigachat" },
    { LLM_PROVIDER: undefined },
  ];
  for (const change of incompatible)
    assert.throws(
      () => readConfig({ ...opted, ...change }),
      /Postpay requires/,
    );
  for (const invalid of ["postpay", "POSTPAY_ACTUAL_V1", "future_version", ""])
    assert.throws(() =>
      readConfig({ ...opted, AI_CUSTOMER_BILLING_MODE: invalid }),
    );
});

test("direct runtime config validation fails closed instead of treating a malformed billing mode as legacy", (t) => {
  forbidNetwork(t);
  const valid = config({ AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1" });
  validateCreditReservationConfig(valid);
  validateCreditReservationConfig(config());
  const changes: Record<string, unknown>[] = [
    { AI_CUSTOMER_BILLING_MODE: "future_version" },
    { AI_CUSTOMER_BILLING_MODE: null },
    { AI_CUSTOMER_BILLING_MODE: undefined },
    { AI_CREDIT_MODE: "disabled" },
    { AI_CREDIT_MODE: "routerai_at_cost" },
    { AI_CREDIT_RESERVATION_MODE: "full" },
    { AI_REQUEST_COST_LIMIT_MODE: "user_balance" },
    { AI_ASSISTANT_MODES: "disabled" },
    { LLM_PROVIDER: "openai" },
  ];
  for (const change of changes) {
    // Explicitly injected configurations need the same boundary as parsed env.
    const forged = { ...valid, ...change } as Config;
    const before = structuredClone(forged);
    assert.throws(
      () => validateCreditReservationConfig(forged),
      Object.hasOwn(change, "AI_CUSTOMER_BILLING_MODE")
        ? /Unsupported customer billing mode/
        : /Postpay requires/,
    );
    assert.deepEqual(forged, before);
  }
});

test("new billing requires new execution and catalog approvals while recipient policies, limits and Minimum price stay unchanged", (t) => {
  forbidNetwork(t);
  const legacy = modes(config());
  const opted = modes(
    config({ AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1" }),
  );
  assert.deepEqual(opted.policy, legacy.policy);
  assert.notEqual(opted.catalogId, legacy.catalogId);
  assert.deepEqual(
    aiModesSchema.parse(opted.modeCatalog()).options,
    legacy.modeCatalog().options,
  );
  for (const id of aiModeIds) {
    const oldRoute = legacy.resolve(routing(legacy), {
      aiMode: id,
      aiModeCatalogId: legacy.catalogId,
    });
    const newRoute = opted.resolve(routing(opted), {
      aiMode: id,
      aiModeCatalogId: opted.catalogId,
    });
    assert.deepEqual(newRoute.policy, oldRoute.policy);
    assert.equal(newRoute.model, oldRoute.model);
    assert.equal(newRoute.provider.name, oldRoute.provider.name);
    assert.equal(newRoute.upstream, oldRoute.upstream);
    assert.equal(
      newRoute.execution.maxInputBytes,
      oldRoute.execution.maxInputBytes,
    );
    assert.equal(
      newRoute.execution.maxOutputTokens,
      oldRoute.execution.maxOutputTokens,
    );
    assert.notEqual(newRoute.execution.key, oldRoute.execution.key);
    for (const [target, staleCatalog] of [
      [opted, legacy.catalogId],
      [legacy, opted.catalogId],
    ] as const)
      assert.throws(
        () =>
          target.resolve(routing(target), {
            aiMode: id,
            aiModeCatalogId: staleCatalog,
          }),
        { code: "AI_MODE_CHANGED", statusCode: 409 },
      );
    if (id === "minimum") {
      assert.ok(oldRoute.fixedFee && newRoute.fixedFee);
      assert.notEqual(newRoute.fixedFee.pricingId, oldRoute.fixedFee.pricingId);
      assert.equal(newRoute.fixedFee.accountRef, oldRoute.fixedFee.accountRef);
      assert.equal(newRoute.fixedFee.scope, oldRoute.fixedFee.scope);
      assert.equal(newRoute.fixedFee.leaseMs, oldRoute.fixedFee.leaseMs);
      assert.deepEqual(
        opted.modeCatalog().options.find((option) => option.id === id)?.price,
        {
          kind: "fixed",
          currency: "RUB",
          amountMicros: 3_000_000,
        },
      );
    } else assert.equal(newRoute.fixedFee, undefined);
  }
});

test("postpay approval and provider-account identity survive credential rotation without exposing secrets", (t) => {
  forbidNetwork(t);
  const before = modes(
    config({ AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1" }),
  );
  const after = modes(
    config({
      AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
      ROUTERAI_API_KEY: "rotated-synthetic-router-secret",
      GIGACHAT_CREDENTIALS: Buffer.from(
        "postpay-client:rotated-synthetic-minimum-secret",
      ).toString("base64"),
    }),
  );
  assert.deepEqual(snapshot(after), snapshot(before));
  assert.doesNotMatch(
    JSON.stringify(snapshot(after)),
    /synthetic-router|synthetic-minimum-secret|postpay-client/,
  );
  assert.doesNotMatch(
    JSON.stringify(after.modeCatalog()),
    /routerai|openai|deepseek|gigachat|credentials/i,
  );
});

test("postpay never activates an invalid Minimum tariff, and the global provider stop still blocks all three modes", (t) => {
  forbidNetwork(t);
  for (const change of [
    { AI_MINIMUM_FIXED_FEE: "disabled" },
    { GIGACHAT_CREDENTIALS: undefined },
    { GIGACHAT_CREDENTIALS: "not-canonical-base64" },
    { GIGACHAT_SCOPE: "GIGACHAT_API_CORP" },
    { GIGACHAT_MODEL: "GigaChat-other-model" },
  ]) {
    const value = modes(
      config({ AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1", ...change }),
    );
    assert.deepEqual(
      value.modeCatalog().options.map(({ available }) => available),
      [true, true, false],
    );
    assert.equal(
      value.routes.find((route) => route.id === "minimum")?.fixedFee,
      undefined,
    );
    assert.equal(
      value.modeCatalog().options.find((option) => option.id === "minimum")
        ?.price,
      undefined,
    );
    assert.throws(() => value.resolve(routing(value), { aiMode: "minimum" }), {
      code: "AI_MODE_UNAVAILABLE",
    });
  }
  const stopped = modes(
    config({
      AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
      LLM_PROVIDER: "disabled",
    }),
  );
  assert.equal(stopped.environmentEnabled, false);
  assert.ok(stopped.modeCatalog().options.every((option) => !option.available));
  for (const aiMode of aiModeIds)
    assert.throws(() => stopped.resolve(routing(stopped), { aiMode }), {
      code: "AI_UNAVAILABLE",
    });
});

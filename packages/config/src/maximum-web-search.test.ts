import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, validateMaximumWebSearchConfig } from "./index.js";

const candidate = {
  NODE_ENV: "test",
  AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
};

const postpayTest = {
  NODE_ENV: "test",
  LLM_PROVIDER: "routerai",
  AI_ASSISTANT_MODES: "enabled",
  AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_test_v1",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  AI_REQUEST_COST_LIMIT_MODE: "operator_ceiling",
};

test("production-capable native search is opt-in to the complete three-mode memory postpay shape", () => {
  const settings = {
    ...postpayTest,
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
    AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    LLM_MAX_INPUT_BYTES: "8388608",
    AI_MINIMUM_FIXED_FEE: "enabled",
    GIGACHAT_MODEL: "GigaChat-3-Ultra",
    GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  };
  const config = readConfig(settings);
  assert.equal(config.AI_MAXIMUM_WEB_SEARCH, "routerai_native_postpay_v1");
  assert.doesNotThrow(() =>
    validateMaximumWebSearchConfig({ ...config, NODE_ENV: "production" }),
  );
  for (const changed of [
    { NODE_ENV: "development" },
    { AI_ASSISTANT_MODES: "disabled" },
    { AI_CREDIT_MODE: "disabled" },
    { AI_CUSTOMER_BILLING_MODE: "legacy" },
    { AI_CREDIT_RESERVATION_MODE: "full" },
    { AI_REQUEST_COST_LIMIT_MODE: "user_balance" },
    { AI_CONTEXT_STRATEGY: "legacy" },
    { AI_MINIMUM_FIXED_FEE: "disabled" },
    { GIGACHAT_MODEL: "other" },
    { GIGACHAT_SCOPE: "GIGACHAT_API_CORP" },
  ])
    assert.throws(
      () => readConfig({ ...settings, ...changed }),
      /explicit three-mode memory CityGo10x profile/,
    );
});

test("native total-cost settlement is an explicit test-only postpay profile, never a candidate upgrade", () => {
  const config = readConfig(postpayTest);
  assert.equal(config.AI_MAXIMUM_WEB_SEARCH, "routerai_native_postpay_test_v1");
  assert.equal(config.AI_CUSTOMER_BILLING_MODE, "postpay_actual_v1");
  for (const changed of [
    { NODE_ENV: "production" },
    { NODE_ENV: "development" },
    { AI_ASSISTANT_MODES: "disabled" },
    { AI_CREDIT_MODE: "disabled" },
    { AI_CREDIT_MODE: "routerai_at_cost" },
    { AI_CUSTOMER_BILLING_MODE: "legacy" },
    { AI_CREDIT_RESERVATION_MODE: "full" },
    { AI_REQUEST_COST_LIMIT_MODE: "user_balance" },
  ]) {
    assert.throws(
      () => readConfig({ ...postpayTest, ...changed }),
      /test-only CityGo10x profile/,
    );
    assert.throws(
      () =>
        validateMaximumWebSearchConfig({
          ...config,
          ...changed,
        } as typeof config),
      /test-only CityGo10x profile/,
    );
  }
  assert.throws(
    () =>
      readConfig({
        ...postpayTest,
        AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
      }),
    /unbillable non-production candidate/,
  );
});

test("native search defaults off and cannot become a paid or production profile", () => {
  assert.equal(readConfig({}).AI_MAXIMUM_WEB_SEARCH, "disabled");
  for (const environment of ["test", "development"])
    assert.equal(
      readConfig({ ...candidate, NODE_ENV: environment }).AI_CREDIT_MODE,
      "disabled",
    );
  for (const changed of [
    { NODE_ENV: "production" },
    { AI_CREDIT_MODE: "routerai_at_cost" },
    { AI_CREDIT_MODE: "routerai_citygo_10x" },
    { AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1" },
    { AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft" },
    { AI_REQUEST_COST_LIMIT_MODE: "user_balance" },
    { AI_MINIMUM_FIXED_FEE: "enabled" },
  ]) {
    assert.throws(
      () => readConfig({ ...candidate, ...changed }),
      /unbillable non-production candidate/,
    );
    assert.throws(
      () =>
        validateMaximumWebSearchConfig({
          ...readConfig(candidate),
          ...changed,
        } as ReturnType<typeof readConfig>),
      /unbillable non-production candidate/,
    );
  }
  for (const invalid of [
    "enabled",
    "native",
    "",
    "routerai_native_candidate_v2",
  ])
    assert.throws(() => readConfig({ AI_MAXIMUM_WEB_SEARCH: invalid }));
});

test("source memory has only a narrow unbillable local search exception; paid memory guards remain", () => {
  const memory = {
    ...candidate,
    LLM_PROVIDER: "routerai",
    AI_ASSISTANT_MODES: "enabled",
    AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    LLM_MAX_INPUT_BYTES: "8388608",
    GIGACHAT_MODEL: "GigaChat-3-Ultra",
    GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  };
  const parsed = readConfig(memory);
  assert.equal(parsed.AI_CUSTOMER_BILLING_MODE, "legacy");
  assert.equal(parsed.AI_CREDIT_MODE, "disabled");
  assert.equal(parsed.AI_CREDIT_RESERVATION_MODE, "full");
  assert.equal(parsed.AI_MINIMUM_FIXED_FEE, "disabled");
  assert.equal(parsed.LLM_MAX_INPUT_BYTES, 8388608);
  assert.throws(
    () => readConfig({ ...memory, AI_MAXIMUM_WEB_SEARCH: "disabled" }),
    /three-mode postpay profile/,
  );
  for (const changed of [
    { AI_ASSISTANT_MODES: "disabled" },
    { GIGACHAT_MODEL: "other" },
    { GIGACHAT_SCOPE: "other" },
  ])
    assert.throws(
      () => readConfig({ ...memory, ...changed }),
      /three-mode postpay profile/,
    );
  for (const changed of [
    { NODE_ENV: "production" },
    { AI_CREDIT_MODE: "routerai_citygo_10x" },
    { AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1" },
    { AI_REQUEST_COST_LIMIT_MODE: "user_balance" },
  ])
    assert.throws(
      () => readConfig({ ...memory, ...changed }),
      /unbillable non-production candidate/,
    );
});

import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { assistantInstructionOptions } from "./assistant-instruction-options.js";

test("only a server-configured unbillable Maximum candidate receives search instructions", () => {
  const legacy = readConfig({ AI_ASSISTANT_MODES: "enabled" });
  const candidate = readConfig({
    NODE_ENV: "test",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
  });
  for (const mode of [undefined, "maximum", "balanced", "minimum"] as const)
    assert.equal(assistantInstructionOptions(legacy, mode), undefined);
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(assistantInstructionOptions(candidate, mode), undefined);
  assert.deepEqual(assistantInstructionOptions(candidate, "maximum"), {
    webSearch: "routerai_native_candidate_v1",
  });
  assert.equal(
    assistantInstructionOptions(
      { ...candidate, AI_ASSISTANT_MODES: "disabled" },
      "maximum",
    ),
    undefined,
  );
  for (const config of [
    { ...candidate, NODE_ENV: "production" as const },
    { ...candidate, AI_CREDIT_MODE: "routerai_citygo_10x" as const },
  ])
    assert.throws(
      () => assistantInstructionOptions(config, "maximum"),
      /unbillable non-production candidate/,
    );
});

test("explicit postpay-test Maximum shares the same offline/send instruction choice without enabling other modes", () => {
  const config = readConfig({
    NODE_ENV: "test",
    LLM_PROVIDER: "routerai",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_test_v1",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  });
  assert.deepEqual(assistantInstructionOptions(config, "maximum"), {
    webSearch: "routerai_native_candidate_v1",
  });
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(assistantInstructionOptions(config, mode), undefined);
  assert.throws(
    () =>
      assistantInstructionOptions(
        { ...config, NODE_ENV: "production" },
        "maximum",
      ),
    /test-only CityGo10x profile/,
  );
});

test("production-capable memory Maximum shares native instructions and preserves other mode prompts", () => {
  const config = readConfig({
    NODE_ENV: "test",
    LLM_PROVIDER: "routerai",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
    AI_CONTEXT_STRATEGY: "model_window_memory_v1",
    LLM_MAX_INPUT_BYTES: "8388608",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    AI_MINIMUM_FIXED_FEE: "enabled",
    GIGACHAT_MODEL: "GigaChat-3-Ultra",
    GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  });
  assert.deepEqual(assistantInstructionOptions(config, "maximum"), {
    webSearch: "routerai_native_candidate_v1",
  });
  assert.deepEqual(
    assistantInstructionOptions(
      { ...config, NODE_ENV: "production" },
      "maximum",
    ),
    { webSearch: "routerai_native_candidate_v1" },
  );
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(assistantInstructionOptions(config, mode), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { assistantInstructionOptions } from "./assistant-instruction-options.js";

const requestTime = new Date("2026-11-06T23:59:59.999Z");
const expectedNativeOptions = {
  webSearch: "routerai_native_candidate_v1",
  currentDate: "2026-11-06",
} as const;

test("only a server-configured unbillable Maximum candidate receives search instructions", () => {
  const legacy = readConfig({ AI_ASSISTANT_MODES: "enabled" });
  const candidate = readConfig({
    NODE_ENV: "test",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
  });
  for (const mode of [undefined, "maximum", "balanced", "minimum"] as const)
    assert.equal(
      assistantInstructionOptions(legacy, mode, requestTime),
      undefined,
    );
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(
      assistantInstructionOptions(candidate, mode, requestTime),
      undefined,
    );
  assert.deepEqual(
    assistantInstructionOptions(candidate, "maximum", requestTime),
    {
      ...expectedNativeOptions,
    },
  );
  assert.equal(
    assistantInstructionOptions(
      { ...candidate, AI_ASSISTANT_MODES: "disabled" },
      "maximum",
      requestTime,
    ),
    undefined,
  );
  for (const config of [
    { ...candidate, NODE_ENV: "production" as const },
    { ...candidate, AI_CREDIT_MODE: "routerai_citygo_10x" as const },
  ])
    assert.throws(
      () => assistantInstructionOptions(config, "maximum", requestTime),
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
  assert.deepEqual(
    assistantInstructionOptions(config, "maximum", requestTime),
    {
      ...expectedNativeOptions,
    },
  );
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(
      assistantInstructionOptions(config, mode, requestTime),
      undefined,
    );
  assert.throws(
    () =>
      assistantInstructionOptions(
        { ...config, NODE_ENV: "production" },
        "maximum",
        requestTime,
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
  assert.deepEqual(
    assistantInstructionOptions(config, "maximum", requestTime),
    {
      ...expectedNativeOptions,
    },
  );
  assert.deepEqual(
    assistantInstructionOptions(
      { ...config, NODE_ENV: "production" },
      "maximum",
      requestTime,
    ),
    expectedNativeOptions,
  );
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(
      assistantInstructionOptions(config, mode, requestTime),
      undefined,
    );
});

test("native search uses the trusted UTC request day across a local midnight offset", () => {
  const config = readConfig({
    NODE_ENV: "test",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
  });
  assert.deepEqual(
    assistantInstructionOptions(
      config,
      "maximum",
      new Date("2026-11-07T02:59:59.999+03:00"),
    ),
    expectedNativeOptions,
  );
  assert.deepEqual(
    assistantInstructionOptions(
      config,
      "maximum",
      new Date("2026-11-07T03:00:00.000+03:00"),
    ),
    { ...expectedNativeOptions, currentDate: "2026-11-07" },
  );
});

test("an invalid trusted clock fails only when native Maximum needs a request date", () => {
  const candidate = readConfig({
    NODE_ENV: "test",
    AI_ASSISTANT_MODES: "enabled",
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
  });
  const invalidTime = new Date(NaN);
  assert.throws(
    () => assistantInstructionOptions(candidate, "maximum", invalidTime),
    RangeError,
  );
  for (const mode of [undefined, "balanced", "minimum"] as const)
    assert.equal(
      assistantInstructionOptions(candidate, mode, invalidTime),
      undefined,
    );
  assert.equal(
    assistantInstructionOptions(
      { ...candidate, AI_ASSISTANT_MODES: "disabled" },
      "maximum",
      invalidTime,
    ),
    undefined,
  );
  assert.equal(
    assistantInstructionOptions(
      readConfig({ AI_ASSISTANT_MODES: "enabled" }),
      "maximum",
      invalidTime,
    ),
    undefined,
  );
});

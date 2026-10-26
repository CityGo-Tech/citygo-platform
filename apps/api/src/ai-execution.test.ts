import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";
import { createAiExecution } from "./ai-execution.js";

test("money approval binds recipient model and input/output caps, never credentials", () => {
  const config = readConfig({});
  const policy = createAiPolicy(config, {
    name: "openai",
    model: "test-model",
  })!;
  const execution = createAiExecution(config, policy);
  assert.equal(
    createAiExecution(readConfig({ OPENAI_API_KEY: "test-secret" }), policy)
      .key,
    execution.key,
  );
  assert.notEqual(
    createAiExecution(readConfig({ LLM_MAX_INPUT_BYTES: "32000" }), policy).key,
    execution.key,
  );
  assert.notEqual(
    createAiExecution(readConfig({ LLM_MAX_OUTPUT_TOKENS: "2000" }), policy)
      .key,
    execution.key,
  );
  assert.notEqual(
    createAiExecution(
      config,
      createAiPolicy(config, { name: "openai", model: "different" })!,
    ).key,
    execution.key,
  );
  assert.doesNotMatch(JSON.stringify(execution), /secret/);
});

test("moving RouterAI from Astra to DeepSeek requires its own policy and money approval", () => {
  const astra = readConfig({
    ROUTERAI_UPSTREAM: "openai",
    ROUTERAI_COUNTRY: "us",
    ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
  });
  const deepseek = readConfig({
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "us",
    ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
  });
  const before = createAiPolicy(astra, {
    name: "routerai",
    model: "openai/gpt-6-astra",
  })!;
  const after = createAiPolicy(deepseek, {
    name: "routerai",
    model: "deepseek/deepseek-v4-pro-0813",
  })!;
  assert.notEqual(before.id, after.id);
  assert.notEqual(
    createAiExecution(astra, before).key,
    createAiExecution(deepseek, after).key,
  );
});

test("RouterAI output override changes only its own money approval key", () => {
  const defaults = readConfig({});
  const configured = readConfig({
    LLM_PROVIDER: "openai",
    ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
    ROUTERAI_REQUEST_TIMEOUT_MS: "240000",
    ROUTERAI_REASONING_EFFORT: "high",
  });
  for (const provider of ["openai", "routerai", "gigachat"] as const) {
    const policy = createAiPolicy(defaults, {
      name: provider,
      model: "test-model",
    })!;
    const before = createAiExecution(defaults, policy);
    const after = createAiExecution(configured, policy);
    assert.equal(after.maxInputBytes, before.maxInputBytes);
    if (provider === "routerai") {
      assert.equal(after.maxOutputTokens, 32768);
      assert.notEqual(after.key, before.key);
    } else {
      assert.deepEqual(after, before);
      assert.equal(after.maxOutputTokens, 1400);
    }
  }
});

test("partial prepayment needs a new money approval while full mode and recipient consent keep their identities", () => {
  const common = {
    LLM_PROVIDER: "routerai",
    AI_CREDIT_MODE: "routerai_citygo_10x",
  };
  const full = readConfig(common);
  const fixed = readConfig({
    ...common,
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  });
  const provider = { name: "routerai" as const, model: "synthetic/model" };
  const policy = createAiPolicy(full, provider)!;
  assert.deepEqual(createAiPolicy(fixed, provider), policy);
  const original = createAiExecution(full, policy);
  assert.equal(
    original.key,
    createHash("sha256")
      .update(
        JSON.stringify({
          version: "ai-reserve-v1",
          policyId: policy.id,
          maxInputBytes: original.maxInputBytes,
          maxOutputTokens: original.maxOutputTokens,
        }),
      )
      .digest("hex"),
  );
  const updated = createAiExecution(fixed, policy);
  assert.notEqual(updated.key, original.key);
  assert.equal(updated.maxInputBytes, original.maxInputBytes);
  assert.equal(updated.maxOutputTokens, original.maxOutputTokens);
});

test("a fixed Minimum billing profile is part of the frozen execution approval", () => {
  const config = readConfig({});
  const policy = createAiPolicy(config, {
    name: "gigachat",
    model: "GigaChat-3-Ultra",
  })!;
  const mode = { protocol: "gigachat" as const, requestTimeoutMs: 60_000 };
  const before = createAiExecution(config, policy, mode);
  const fixed = createAiExecution(config, policy, {
    ...mode,
    billingProfile: { pricingId: "a".repeat(64) },
  });
  assert.notEqual(fixed.key, before.key);
  assert.notEqual(
    fixed.key,
    createAiExecution(config, policy, {
      ...mode,
      billingProfile: { pricingId: "b".repeat(64) },
    }).key,
  );
  assert.deepEqual(fixed.policy, before.policy);
  assert.deepEqual(
    fixed,
    createAiExecution(
      { ...config, GIGACHAT_CREDENTIALS: "rotated-private-key" },
      policy,
      { ...mode, billingProfile: { pricingId: "a".repeat(64) } },
    ),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
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

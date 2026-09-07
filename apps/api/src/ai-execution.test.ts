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

import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";

test("recipient snapshot changes for model, provider, upstream, country and account scope", () => {
  const provider = { name: "routerai" as const, model: "test/model" };
  const config = readConfig({
    ROUTERAI_UPSTREAM: "test-upstream",
    ROUTERAI_COUNTRY: "ru",
  });
  const policy = createAiPolicy(config, provider)!;
  assert.match(policy.id, /^[a-f0-9]{64}$/);
  for (const changed of [
    createAiPolicy(config, { ...provider, model: "test/other" }),
    createAiPolicy(config, { ...provider, name: "openai" }),
    createAiPolicy({ ...config, ROUTERAI_UPSTREAM: "other" }, provider),
    createAiPolicy({ ...config, ROUTERAI_COUNTRY: "us" }, provider),
  ])
    assert.notEqual(changed!.id, policy.id);
  const giga = { name: "gigachat" as const, model: "GigaChat-test" };
  assert.notEqual(
    createAiPolicy({ ...config, GIGACHAT_SCOPE: "GIGACHAT_API_PERS" }, giga)!
      .id,
    createAiPolicy({ ...config, GIGACHAT_SCOPE: "GIGACHAT_API_B2B" }, giga)!.id,
  );
  assert.equal(createAiPolicy(config), null);
});

test("recipient snapshot excludes keys, certificate paths and inactive provider settings", () => {
  const provider = { name: "openai" as const, model: "test-model" };
  const original = createAiPolicy(readConfig({}), provider);
  const changed = createAiPolicy(
    readConfig({
      OPENAI_API_KEY: "secret-openai",
      ROUTERAI_API_KEY: "secret-router",
      GIGACHAT_CREDENTIALS: "secret-giga",
      GIGACHAT_CA_BUNDLE_FILE: "secret-path",
      ROUTERAI_UPSTREAM: "other",
    }),
    provider,
  );
  assert.deepEqual(changed, original);
  assert.doesNotMatch(JSON.stringify(changed), /secret/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { TestProvider } from "@citygo/testkit";
import { createAiControl } from "./ai-control.js";

test("control never falls back when the stored recipient differs from local configuration", () => {
  const control = createAiControl(readConfig({}), {
    openai: new TestProvider(),
    gigachat: new TestProvider("gigachat"),
  });
  assert.equal(
    control.resolve({
      provider: "openai",
      policyId: "a".repeat(64),
      revision: 1,
    }).provider,
    undefined,
  );
  const policy = control.options[0]!.policy!;
  assert.equal(
    control.resolve({ provider: "openai", policyId: policy.id, revision: 1 })
      .provider?.name,
    "openai",
  );
  assert.equal(
    control.resolve({ provider: "disabled", policyId: null, revision: 2 })
      .provider,
    undefined,
  );
});

test("control enforces production and hard-disable boundaries even for injected instances", () => {
  for (const config of [
    readConfig({ LLM_PROVIDER: "disabled" }),
    readConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/citygo",
      WEB_ORIGIN: "https://citygo.example",
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    }),
  ]) {
    const control = createAiControl(config, {
      openai: new TestProvider(),
      routerai: new TestProvider("routerai"),
      gigachat: new TestProvider("gigachat"),
    });
    assert.equal(control.options[1]!.policy, null);
    assert.equal(control.options[2]!.policy, null);
    assert.equal(
      control.options[1]!.unavailableReason,
      config.NODE_ENV === "production"
        ? "production_blocked"
        : "server_disabled",
    );
  }
});

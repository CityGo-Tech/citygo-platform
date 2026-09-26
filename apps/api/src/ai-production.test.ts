import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";
import { productionProviderAllowed } from "./ai-production.js";
import { createProvider, createProviderRegistry } from "./provider.js";
import { createAiControl } from "./ai-control.js";
import { TestProvider } from "@citygo/testkit";

const env = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost/not-used",
  WEB_ORIGIN: "https://citygo.example",
  TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  LLM_PROVIDER: "routerai",
  ROUTERAI_API_KEY: "synthetic-router-key",
  ROUTERAI_MODEL: "test/model",
  ROUTERAI_UPSTREAM: "test-upstream",
  ROUTERAI_COUNTRY: "us",
  ROUTERAI_DATA_NOTICE: "Synthetic notice. Not approved for real users.",
  OPENAI_API_KEY: "synthetic-openai-key",
  OPENAI_MODEL: "test-openai",
};
const identity = { name: "routerai" as const, model: env.ROUTERAI_MODEL };
const policy = createAiPolicy(readConfig(env), identity)!;
const approved = { ...env, ROUTERAI_PRODUCTION_POLICY_ID: policy.id };

test("production RouterAI requires exact independently supplied approval, without model I/O", (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network allowed");
  });
  assert.throws(
    () => createProvider(readConfig(env)),
    /production activation is blocked/,
  );
  const config = readConfig(approved);
  assert.equal(productionProviderAllowed(config, identity), true);
  assert.equal(createProvider(config)?.name, "routerai");
  assert.deepEqual(createAiPolicy(config, identity), policy);
  assert.equal(policy.version, "ai-recipient-v2");
  assert.match(policy.data, /Synthetic notice/);
  assert.doesNotMatch(
    JSON.stringify(policy),
    /synthetic-router-key|synthetic-openai-key/,
  );
  assert.equal(network.mock.callCount(), 0);
});

test("changing recipient, model, country or notice invalidates production approval", () => {
  for (const change of [
    { ROUTERAI_MODEL: "test/other" },
    { ROUTERAI_UPSTREAM: "other" },
    { ROUTERAI_COUNTRY: "ru" },
    { ROUTERAI_COUNTRY: "" },
    { ROUTERAI_DATA_NOTICE: "A changed public notice" },
    { ROUTERAI_DATA_NOTICE: "" },
    { ROUTERAI_PRODUCTION_POLICY_ID: "a".repeat(64) },
    { ROUTERAI_PRODUCTION_POLICY_ID: "" },
  ]) {
    const config = readConfig({ ...approved, ...change });
    assert.throws(
      () => createProvider(config),
      /production activation is blocked/,
    );
    assert.equal(
      createAiControl(config, {
        routerai: {
          ...identity,
          model: config.ROUTERAI_MODEL!,
          async *stream() {
            yield { type: "delta" as const, text: "unexpected invocation" };
          },
        },
      }).options[1]!.unavailableReason,
      "production_blocked",
    );
  }
  const withoutNotice = readConfig({ ...env, ROUTERAI_DATA_NOTICE: "" });
  assert.equal(
    productionProviderAllowed(
      {
        ...withoutNotice,
        ROUTERAI_PRODUCTION_POLICY_ID: createAiPolicy(withoutNotice, identity)!
          .id,
      },
      identity,
    ),
    false,
    "a hash of the old technical notice is insufficient",
  );
  assert.equal(
    productionProviderAllowed(readConfig(approved), {
      ...identity,
      model: "other/model",
    }),
    false,
  );
});

test("approval preserves manual switching, hard-disable, independent keys and GigaChat block", () => {
  const config = readConfig(approved);
  const registry = createProviderRegistry({
    ...config,
    LLM_PROVIDER: "openai",
  });
  assert.equal(registry.provider?.name, "openai");
  assert.equal(registry.providers.routerai?.model, identity.model);
  assert.equal(registry.providers.gigachat, undefined);
  const disabled = { ...config, LLM_PROVIDER: "disabled" as const };
  assert.deepEqual(createProviderRegistry(disabled), {
    provider: undefined,
    providers: {},
  });
  assert.equal(
    createAiControl(disabled, registry.providers).options[1]!.unavailableReason,
    "server_disabled",
  );
  assert.equal(
    productionProviderAllowed(config, new TestProvider("gigachat")),
    false,
  );
  const drift = { ...config, ROUTERAI_DATA_NOTICE: "Changed" };
  const fallback = createProviderRegistry({ ...drift, LLM_PROVIDER: "openai" });
  assert.equal(fallback.provider?.name, "openai");
  assert.equal(fallback.providers.routerai, undefined);
  assert.equal(
    createAiControl(config, registry.providers).resolve({
      provider: "routerai",
      policyId: "b".repeat(64),
      revision: 1,
    }).provider,
    undefined,
  );
});

test("notice and approval cannot affect other providers or key rotation", () => {
  const original = readConfig(env);
  const withNewKey = readConfig({
    ...approved,
    ROUTERAI_API_KEY: "rotated-key",
  });
  assert.deepEqual(createAiPolicy(withNewKey, identity), policy);
  for (const name of ["openai", "gigachat"] as const) {
    assert.deepEqual(
      createAiPolicy(original, { name, model: "test" }),
      createAiPolicy(readConfig({ ...env, ROUTERAI_DATA_NOTICE: "" }), {
        name,
        model: "test",
      }),
    );
  }
});

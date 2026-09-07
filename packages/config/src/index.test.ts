import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "./index.js";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost/citygo",
  WEB_ORIGIN: "https://citygo.example",
  TRUSTED_PROXY_CIDRS: "10.0.0.8/32, ::1/128",
};

test("AI context byte limit is a bounded integer", () => {
  assert.equal(readConfig({}).LLM_MAX_INPUT_BYTES, 64000);
  for (const value of ["0", "1023", "262145", "1.5", "NaN", "Infinity"])
    assert.throws(() => readConfig({ LLM_MAX_INPUT_BYTES: value }));
  assert.equal(
    readConfig({ LLM_MAX_INPUT_BYTES: "1024" }).LLM_MAX_INPUT_BYTES,
    1024,
  );
});

test("daily admission limits are bounded integers; zero disables admission", () => {
  assert.equal(readConfig({}).LLM_USER_DAILY_REQUEST_LIMIT, 20);
  assert.equal(readConfig({}).LLM_GLOBAL_DAILY_REQUEST_LIMIT, 200);
  for (const name of [
    "LLM_USER_DAILY_REQUEST_LIMIT",
    "LLM_GLOBAL_DAILY_REQUEST_LIMIT",
  ] as const) {
    assert.equal(readConfig({ [name]: "0" })[name], 0);
    for (const value of ["-1", "1.5", "NaN", "1000001"])
      assert.throws(() => readConfig({ [name]: value }));
  }
});

test("model attempt limits are separate bounded integers with a hard zero stop", () => {
  assert.equal(readConfig({}).LLM_USER_DAILY_ATTEMPT_LIMIT, 20);
  assert.equal(readConfig({}).LLM_GLOBAL_DAILY_ATTEMPT_LIMIT, 200);
  for (const name of [
    "LLM_USER_DAILY_ATTEMPT_LIMIT",
    "LLM_GLOBAL_DAILY_ATTEMPT_LIMIT",
  ] as const) {
    assert.equal(readConfig({ [name]: "0" })[name], 0);
    for (const value of ["-1", "1.5", "NaN", "Infinity", "1000001"])
      assert.throws(() => readConfig({ [name]: value }));
  }
  assert.throws(() => readConfig({ LLM_USER_DAILY_ATTEMPT_LIMIT: "10001" }));
});

test("GigaChat settings are blank-safe and do not implicitly select a provider", () => {
  const config = readConfig({
    GIGACHAT_CREDENTIALS: " key ",
    GIGACHAT_MODEL: " GigaChat-test ",
    GIGACHAT_SCOPE: " GIGACHAT_API_PERS ",
    GIGACHAT_CA_BUNDLE_FILE: " ",
  });
  assert.equal(config.GIGACHAT_CREDENTIALS, "key");
  assert.equal(config.GIGACHAT_MODEL, "GigaChat-test");
  assert.equal(config.GIGACHAT_SCOPE, "GIGACHAT_API_PERS");
  assert.equal(config.GIGACHAT_CA_BUNDLE_FILE, undefined);
  assert.equal(config.LLM_PROVIDER, undefined);
});

test("RouterAI settings are trimmed, blank-safe and never implicitly select it", () => {
  const config = readConfig({
    ROUTERAI_API_KEY: " test-key ",
    ROUTERAI_MODEL: " test/model ",
    ROUTERAI_UPSTREAM: " test-upstream ",
    ROUTERAI_COUNTRY: " ",
  });
  assert.equal(config.ROUTERAI_API_KEY, "test-key");
  assert.equal(config.ROUTERAI_MODEL, "test/model");
  assert.equal(config.ROUTERAI_UPSTREAM, "test-upstream");
  assert.equal(config.ROUTERAI_COUNTRY, undefined);
  assert.equal(config.LLM_PROVIDER, undefined);
});

test("provider settings preserve blank defaults and validate IDs and limits", () => {
  assert.equal(readConfig({ LLM_PROVIDER: " " }).LLM_PROVIDER, undefined);
  for (const LLM_PROVIDER of ["openai", "routerai", "gigachat", "disabled"])
    assert.equal(readConfig({ LLM_PROVIDER }).LLM_PROVIDER, LLM_PROVIDER);
  assert.throws(() => readConfig({ LLM_PROVIDER: "typo" }), /LLM_PROVIDER/);
  assert.equal(readConfig({}).LLM_REQUEST_TIMEOUT_MS, 60000);
  assert.equal(readConfig({}).LLM_MAX_OUTPUT_TOKENS, 1400);
  assert.equal(readConfig({ OPENAI_MODEL: " model " }).OPENAI_MODEL, "model");
  for (const value of ["0", "-1", "60001", "no", "1000.5"])
    assert.throws(
      () => readConfig({ LLM_REQUEST_TIMEOUT_MS: value }),
      /LLM_REQUEST_TIMEOUT_MS/,
    );
  for (const value of ["0", "-1", "8001", "no", "1.5"])
    assert.throws(
      () => readConfig({ LLM_MAX_OUTPUT_TOKENS: value }),
      /LLM_MAX_OUTPUT_TOKENS/,
    );
});

test("proxy trust is disabled by default and only accepts explicit IPs/CIDRs", () => {
  assert.deepEqual(readConfig({}).TRUSTED_PROXY_CIDRS, []);
  assert.deepEqual(readConfig(production).TRUSTED_PROXY_CIDRS, [
    "10.0.0.8/32",
    "::1/128",
  ]);
  for (const value of [
    "true",
    "1",
    "*",
    "loopback",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.8/33",
    "::1/129",
    "10.0.0.8,",
  ])
    assert.throws(
      () => readConfig({ TRUSTED_PROXY_CIDRS: value }),
      /TRUSTED_PROXY_CIDRS/,
    );
});

test("production rejects local databases, HTTP and missing proxy trust", () => {
  assert.throws(
    () => readConfig({ ...production, DATABASE_URL: "pglite://:memory:" }),
    /PostgreSQL and HTTPS/,
  );
  assert.throws(
    () => readConfig({ ...production, DATABASE_URL: "postgres-not-a-url" }),
    /PostgreSQL and HTTPS/,
  );
  assert.throws(
    () => readConfig({ ...production, WEB_ORIGIN: "http://citygo.example" }),
    /PostgreSQL and HTTPS/,
  );
  assert.throws(
    () => readConfig({ ...production, TRUSTED_PROXY_CIDRS: "" }),
    /TRUSTED_PROXY_CIDRS/,
  );
});

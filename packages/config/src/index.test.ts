import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "./index.js";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost/citygo",
  WEB_ORIGIN: "https://citygo.example",
  TRUSTED_PROXY_CIDRS: "10.0.0.8/32, ::1/128",
};

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

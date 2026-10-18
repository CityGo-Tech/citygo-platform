import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, effectiveLlmLimits } from "./index.js";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost/citygo",
  WEB_ORIGIN: "https://citygo.example",
  TRUSTED_PROXY_CIDRS: "10.0.0.8/32, ::1/128",
};

test("YooKassa defaults disabled; test checkout cannot coexist with real AI or production", () => {
  assert.equal(readConfig({}).YOOKASSA_MODE, "disabled");
  const isolated = {
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    YOOKASSA_MODE: "test",
    YOOKASSA_SHOP_ID: "12345",
    YOOKASSA_SECRET_KEY: "test_synthetic_nonworking",
  };
  assert.equal(readConfig(isolated).YOOKASSA_MODE, "test");
  for (const patch of [
    production,
    { LLM_PROVIDER: "routerai" },
    { LLM_PROVIDER: undefined },
    { AI_CREDIT_MODE: "disabled" },
    { YOOKASSA_SHOP_ID: undefined },
    { YOOKASSA_SHOP_ID: "0" },
    { YOOKASSA_SECRET_KEY: "live_not_a_real_key" },
    { YOOKASSA_SECRET_KEY: undefined },
  ]) {
    assert.throws(
      () => readConfig({ ...isolated, ...patch }),
      /isolated non-production/,
    );
  }
  for (const mode of ["live", "true", "enabled", ""]) {
    assert.throws(() => readConfig({ YOOKASSA_MODE: mode }));
  }
});

test("live YooKassa requires exact credentials, HTTPS, CityGo tariff and an explicit NPD workflow", () => {
  const live = {
    ...production,
    LLM_PROVIDER: "routerai",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    YOOKASSA_MODE: "live",
    YOOKASSA_SHOP_ID: "123456",
    YOOKASSA_SECRET_KEY: "live_SYNTHETIC_NOT_A_REAL_KEY",
    YOOKASSA_RECEIPT_MODE: "npd_manual",
  };
  assert.equal(readConfig(live).YOOKASSA_MODE, "live");
  assert.equal(
    readConfig({ ...live, LLM_PROVIDER: "disabled" }).YOOKASSA_MODE,
    "live",
  );
  for (const patch of [
    { YOOKASSA_SECRET_KEY: "test_SYNTHETIC_NOT_A_REAL_KEY" },
    { YOOKASSA_SECRET_KEY: undefined },
    { YOOKASSA_SHOP_ID: "0" },
    { YOOKASSA_SHOP_ID: undefined },
    { YOOKASSA_RECEIPT_MODE: undefined },
    { YOOKASSA_RECEIPT_MODE: "disabled" },
    { AI_CREDIT_MODE: "routerai_at_cost" },
    { AI_CREDIT_MODE: "disabled" },
    { LLM_PROVIDER: "openai" },
    { LLM_PROVIDER: "gigachat" },
    { LLM_PROVIDER: undefined },
  ])
    assert.throws(
      () => readConfig({ ...live, ...patch }),
      /live checkout requires/,
    );
  for (const WEB_ORIGIN of [
    "http://citygo.example",
    "https://user:pass@citygo.example",
    "https://citygo.example:444/",
    "https://citygo.example/path",
    "https://citygo.example/?token=private",
    "https://citygo.example/#private",
  ])
    assert.throws(
      () => readConfig({ ...live, WEB_ORIGIN }),
      /HTTPS return origin/,
    );
});

test("housing API defaults closed; synthetic opt-in can never approve production", () => {
  assert.equal(readConfig({}).R1_HOUSING_API_MODE, "disabled");
  assert.equal(
    readConfig({ NODE_ENV: "test", R1_HOUSING_API_MODE: "synthetic" })
      .R1_HOUSING_API_MODE,
    "synthetic",
  );
  assert.equal(
    readConfig({ ...production, R1_HOUSING_API_MODE: "disabled" })
      .R1_HOUSING_API_MODE,
    "disabled",
  );
  for (const mode of ["true", "enabled", "production", "1", ""])
    assert.throws(() => readConfig({ R1_HOUSING_API_MODE: mode }));
  assert.throws(
    () => readConfig({ ...production, R1_HOUSING_API_MODE: "synthetic" }),
    /synthetic-only/,
  );
});

test("RouterAI production approval is blank-safe, bounded and not a boolean switch", () => {
  const empty = readConfig({
    ROUTERAI_DATA_NOTICE: " ",
    ROUTERAI_PRODUCTION_POLICY_ID: " ",
  });
  assert.equal(empty.ROUTERAI_DATA_NOTICE, undefined);
  assert.equal(empty.ROUTERAI_PRODUCTION_POLICY_ID, undefined);
  assert.equal(
    readConfig({ ROUTERAI_DATA_NOTICE: " Notice " }).ROUTERAI_DATA_NOTICE,
    "Notice",
  );
  for (const value of ["true", "1", "a".repeat(63), "G".repeat(64)])
    assert.throws(() => readConfig({ ROUTERAI_PRODUCTION_POLICY_ID: value }));
  assert.throws(() => readConfig({ ROUTERAI_DATA_NOTICE: "x".repeat(4001) }));
  assert.equal(
    readConfig({ ROUTERAI_PRODUCTION_POLICY_ID: "a".repeat(64) })
      .ROUTERAI_PRODUCTION_POLICY_ID,
    "a".repeat(64),
  );
});

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

test("RouterAI optional output, deadline and reasoning settings are bounded and blank-safe", () => {
  for (const blank of [undefined, "", " "]) {
    const config = readConfig({
      ROUTERAI_REASONING_EFFORT: blank,
      ROUTERAI_MAX_OUTPUT_TOKENS: blank,
      ROUTERAI_REQUEST_TIMEOUT_MS: blank,
    });
    assert.equal(config.ROUTERAI_REASONING_EFFORT, undefined);
    assert.equal(config.ROUTERAI_MAX_OUTPUT_TOKENS, undefined);
    assert.equal(config.ROUTERAI_REQUEST_TIMEOUT_MS, undefined);
    assert.equal(config.LLM_PROVIDER, undefined);
  }
  for (const effort of ["low", "medium", "high", "xhigh", "max"])
    assert.equal(
      readConfig({ ROUTERAI_REASONING_EFFORT: ` ${effort} ` })
        .ROUTERAI_REASONING_EFFORT,
      effort,
    );
  for (const effort of ["none", "minimal", "ultra", "HIGH", "typo"])
    assert.throws(() => readConfig({ ROUTERAI_REASONING_EFFORT: effort }));
  for (const value of ["0", "-1", "32769", "1.5", "NaN", "Infinity"])
    assert.throws(() => readConfig({ ROUTERAI_MAX_OUTPUT_TOKENS: value }));
  for (const value of ["0", "999", "240001", "1000.5", "NaN", "Infinity"])
    assert.throws(() => readConfig({ ROUTERAI_REQUEST_TIMEOUT_MS: value }));
  for (const value of ["1", "32768"])
    assert.equal(
      readConfig({ ROUTERAI_MAX_OUTPUT_TOKENS: value })
        .ROUTERAI_MAX_OUTPUT_TOKENS,
      Number(value),
    );
  for (const value of ["1000", "240000"])
    assert.equal(
      readConfig({ ROUTERAI_REQUEST_TIMEOUT_MS: value })
        .ROUTERAI_REQUEST_TIMEOUT_MS,
      Number(value),
    );
});

test("effective limits follow the selected provider and retain all historical defaults", () => {
  const defaults = {
    maxOutputTokens: 1400,
    requestTimeoutMs: 60000,
    chatLeaseMs: 90000,
    maxOutputCharacters: 24000,
  };
  for (const provider of ["openai", "routerai", "gigachat"] as const)
    assert.deepEqual(effectiveLlmLimits(readConfig({}), provider), defaults);
  const overrides = readConfig({
    LLM_PROVIDER: "openai",
    ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
    ROUTERAI_REQUEST_TIMEOUT_MS: "240000",
    ROUTERAI_REASONING_EFFORT: "high",
  });
  assert.deepEqual(effectiveLlmLimits(overrides, "routerai"), {
    maxOutputTokens: 32768,
    requestTimeoutMs: 240000,
    chatLeaseMs: 270000,
    maxOutputCharacters: 24000,
  });
  for (const provider of ["openai", "gigachat"] as const)
    assert.deepEqual(effectiveLlmLimits(overrides, provider), defaults);
  const common = readConfig({
    LLM_MAX_OUTPUT_TOKENS: "2200",
    LLM_REQUEST_TIMEOUT_MS: "12000",
  });
  assert.deepEqual(effectiveLlmLimits(common, "routerai"), {
    maxOutputTokens: 2200,
    requestTimeoutMs: 12000,
    chatLeaseMs: 90000,
    maxOutputCharacters: 24000,
  });
  assert.equal(
    effectiveLlmLimits(overrides, "routerai", "openai/gpt-6-astra")
      .maxOutputCharacters,
    128000,
  );
  assert.equal(
    effectiveLlmLimits(overrides, "openai", "gpt-6-astra").maxOutputCharacters,
    24000,
  );
  assert.equal(
    effectiveLlmLimits(overrides, "routerai", "qwen/qwen3.7-flash")
      .maxOutputCharacters,
    24000,
  );
});

test("DeepSeek Pro quality limits apply only through RouterAI", () => {
  const config = readConfig({
    LLM_PROVIDER: "routerai",
    ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
    ROUTERAI_UPSTREAM: "deepseek",
    ROUTERAI_COUNTRY: "us",
    ROUTERAI_REASONING_EFFORT: "high",
    ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
    ROUTERAI_REQUEST_TIMEOUT_MS: "240000",
  });
  assert.deepEqual(
    effectiveLlmLimits(config, "routerai", config.ROUTERAI_MODEL),
    {
      maxOutputTokens: 32768,
      requestTimeoutMs: 240000,
      chatLeaseMs: 270000,
      maxOutputCharacters: 128000,
    },
  );
  for (const provider of ["openai", "gigachat"] as const)
    assert.deepEqual(
      effectiveLlmLimits(config, provider, config.ROUTERAI_MODEL),
      {
        maxOutputTokens: 1400,
        requestTimeoutMs: 60000,
        chatLeaseMs: 90000,
        maxOutputCharacters: 24000,
      },
    );
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

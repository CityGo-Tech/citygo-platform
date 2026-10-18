import test from "node:test";
import assert from "node:assert/strict";
import {
  aiBudgetInputSchema,
  formatMoneyCounterMicros,
  formatMoneyMicros,
  parseMoneyMicros,
} from "./ai-budget.js";

test("money decimal conversion is exact, bounded and never silently rounded", () => {
  for (const [text, amount] of [
    ["0", 0],
    ["0.000001", 1],
    ["1,012003", 1012003],
    ["1000000", 1000000000000],
    ["123.45", 123450000],
  ] as const) {
    assert.equal(parseMoneyMicros(text), amount);
    assert.equal(parseMoneyMicros(formatMoneyMicros(amount)), amount);
  }
  for (const text of [
    "",
    "-1",
    "1e3",
    "Infinity",
    "NaN",
    "0.0000001",
    "1000000.000001",
    "1,000,000",
    "1 000",
    ".5",
    "1.",
  ])
    assert.equal(parseMoneyMicros(text), null, text);
  for (const value of [-1, 0.1, Infinity, 1000000000001])
    assert.throws(() => formatMoneyMicros(value));
});

test("cumulative money counters render exactly without raising input limits", () => {
  assert.equal(formatMoneyCounterMicros(0), "0");
  assert.equal(formatMoneyCounterMicros(1_000_000_000_001), "1000000.000001");
  assert.equal(
    formatMoneyCounterMicros(Number.MAX_SAFE_INTEGER),
    "9007199254.740991",
  );
  assert.equal(parseMoneyMicros("9007199254.740991"), null);
  assert.throws(() => formatMoneyMicros(Number.MAX_SAFE_INTEGER));
  for (const value of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => formatMoneyCounterMicros(value));
});
test("money settings are strict integers, explicit currency and unique bounded rules", () => {
  const input = {
    expectedRevision: 1,
    enabled: true,
    currency: "RUB",
    dailyLimitMicros: 10,
    totalLimitMicros: 20,
    rules: [{ key: "a".repeat(64), attemptCeilingMicros: 1 }],
  };
  assert.ok(aiBudgetInputSchema.safeParse(input).success);
  for (const change of [
    { currency: "EUR" },
    { currency: null },
    { dailyLimitMicros: 21 },
    { dailyLimitMicros: 0 },
    { totalLimitMicros: 1000000000001 },
    { dailyLimitMicros: 1.5 },
    { rules: [] },
    { rules: [...input.rules, ...input.rules] },
    { rules: [{ ...input.rules[0], attemptCeilingMicros: 0 }] },
    { reset: true },
    { expectedRevision: 2147483647 },
  ])
    assert.equal(
      aiBudgetInputSchema.safeParse({ ...input, ...change }).success,
      false,
      JSON.stringify(change),
    );
  assert.ok(
    aiBudgetInputSchema.safeParse({
      ...input,
      enabled: false,
      dailyLimitMicros: 0,
      rules: [],
    }).success,
  );
});

test("personal daily cap distinguishes omitted, null, zero and exact currency microunits", () => {
  const input = {
    expectedRevision: 1,
    enabled: false,
    currency: "RUB",
    dailyLimitMicros: 5000000000,
    totalLimitMicros: 10000000000,
    rules: [],
  };
  const omitted = aiBudgetInputSchema.parse(input);
  assert.equal(Object.hasOwn(omitted, "userDailyLimitMicros"), false);
  for (const cap of [null, 0, 1, 500000000, 500500000, 1000000000000]) {
    const parsed = aiBudgetInputSchema.parse({
      ...input,
      userDailyLimitMicros: cap,
    });
    assert.equal(parsed.userDailyLimitMicros, cap);
    assert.equal(parsed.enabled, false);
    assert.equal(parsed.dailyLimitMicros, input.dailyLimitMicros);
    assert.equal(parsed.totalLimitMicros, input.totalLimitMicros);
  }
  assert.equal(parseMoneyMicros("500,5"), 500500000);
  for (const cap of [-1, 0.5, NaN, Infinity, "500", false, 1000000000001]) {
    assert.equal(
      aiBudgetInputSchema.safeParse({ ...input, userDailyLimitMicros: cap })
        .success,
      false,
    );
  }
});

test("RouterAI balance mode is explicit, RUB-only, and has truly absent global caps", () => {
  const input = {
    expectedRevision: 1,
    enabled: true,
    mode: "routerai_balance",
    currency: "RUB",
    dailyLimitMicros: null,
    totalLimitMicros: null,
    userDailyLimitMicros: null,
    rules: [{ key: "a".repeat(64), attemptCeilingMicros: 1000000 }],
  };
  assert.deepEqual(aiBudgetInputSchema.parse(input), input);
  for (const patch of [
    { mode: undefined },
    { mode: "fixed" },
    { mode: "unlimited" },
    { currency: "USD" },
    { dailyLimitMicros: 0 },
    { totalLimitMicros: 1000000000000 },
    { rules: [] },
    { rules: [{ ...input.rules[0], attemptCeilingMicros: null }] },
  ])
    assert.equal(
      aiBudgetInputSchema.safeParse({ ...input, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  const { mode: _mode, ...legacy } = {
    ...input,
    dailyLimitMicros: 1,
    totalLimitMicros: 1,
    userDailyLimitMicros: 0,
  };
  assert.equal(_mode, "routerai_balance");
  const parsed = aiBudgetInputSchema.parse(legacy);
  assert.equal(Object.hasOwn(parsed, "mode"), false);
  assert.equal(parsed.userDailyLimitMicros, 0);
});

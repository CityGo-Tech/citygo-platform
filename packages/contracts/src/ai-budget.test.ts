import test from "node:test";
import assert from "node:assert/strict";
import {
  aiBudgetInputSchema,
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

import assert from "node:assert/strict";
import test from "node:test";
import { inspectRouterAiNativeCostObservation as inspect } from "./routerai-native-cost-observation.mjs";

const expected = {
  generationId: "gen-synthetic-native-inspection",
  reference: "4a6d0ab4-f9c5-47bf-a264-6e807ab25430",
};
const data = () => ({
  id: expected.generationId,
  session_id: expected.reference,
  model: "openai/gpt-6.1-sol",
  provider: "openai",
  api: "chat/completions",
  source: "api",
  has_web_search: true,
  total_cost: 1,
  usage: {
    input_tokens: 22621,
    output_tokens: 438,
    input_cached_tokens: 0,
    output_reasoning_tokens: 213,
  },
});
const json = (patch = {}) => JSON.stringify({ data: { ...data(), ...patch } });
const rejected = /^TypeError: Invalid native cost observation$/;

test("exact JSON decimal and nested usage remain an observation without charge conversion", () => {
  const text = json().replace(
    '"total_cost":1',
    '"total_cost":7.391828311140000000000000000001',
  );
  const result = inspect(text, expected);
  assert.deepEqual(result, {
    kind: "routerai-native-cost-observation-v1",
    observationOnly: true,
    identityMatched: true,
    hasWebSearchReported: true,
    totalCost: {
      jsonType: "number",
      rawDecimal: "7.391828311140000000000000000001",
    },
    currencyReported: "missing",
    usage: {
      inputTokens: 22621,
      outputTokens: 438,
      inputCachedTokens: 0,
      outputReasoningTokens: 213,
    },
    billingEligible: false,
    customerReceiptAccepted: false,
    nativeSearchFees: "not-inferred",
    costFinality: "unknown",
  });
  assert.equal(Object.hasOwn(result, "amountMicros"), false);
});

test("zero and declared RUB never claim free/final cost or fee inclusion", () => {
  const result = inspect(json({ total_cost: 0, currency: "RUB" }), expected);
  assert.equal(result.totalCost.rawDecimal, "0");
  assert.equal(result.currencyReported, "RUB");
  assert.equal(result.billingEligible, false);
  assert.equal(result.costFinality, "unknown");
  assert.equal(result.nativeSearchFees, "not-inferred");
});

test("every pinned identity, native-search boolean and currency must match", () => {
  for (const patch of [
    { id: "other" },
    { session_id: "other" },
    { model: "openai/other" },
    { provider: "other" },
    { api: "responses" },
    { source: "chat" },
    { has_web_search: false },
    { has_web_search: "true" },
    { has_web_search: undefined },
    { currency: "USD" },
    { currency: null },
  ])
    assert.throws(() => inspect(json(patch), expected), rejected);
  for (const badExpected of [
    undefined,
    {},
    { ...expected, generationId: "x?secret" },
    { ...expected, reference: "bad" },
  ])
    assert.throws(() => inspect(json(), badExpected), rejected);
});

test("only the single data envelope is inspected, never outer or alternative receipt fields", () => {
  for (const envelope of [
    data(),
    { receipt: data() },
    { data: data(), total_cost: 1 },
    { data: [data()] },
    { data: null },
    { data: { ...data(), total_cost: undefined } },
    [],
    null,
  ])
    assert.throws(() => inspect(JSON.stringify(envelope), expected), rejected);
});

test("cost is a bounded nonnegative numeric decimal lexeme, never an approximated float", () => {
  for (const literal of [
    '"1.23"',
    "-1",
    "-0",
    "null",
    "{}",
    "1e400",
    "1e2",
    "9007199254740992",
    "9007199254740991.1",
    "0." + "1".repeat(31),
  ]) {
    const text = json().replace('"total_cost":1', '"total_cost":' + literal);
    assert.throws(() => inspect(text, expected), rejected);
  }
  const maximum = json().replace(
    '"total_cost":1',
    '"total_cost":9007199254740991.000',
  );
  assert.equal(
    inspect(maximum, expected).totalCost.rawDecimal,
    "9007199254740991.000",
  );
});

test("optional usage maps only nested documented counters and checks integer/subset bounds", () => {
  assert.equal(
    Object.hasOwn(inspect(json({ usage: undefined }), expected), "usage"),
    false,
  );
  assert.equal(
    Object.hasOwn(inspect(json({ usage: {} }), expected), "usage"),
    false,
  );
  assert.deepEqual(
    inspect(json({ usage: { input_tokens: 10 } }), expected).usage,
    { inputTokens: 10 },
  );
  for (const usage of [
    null,
    [],
    { input_tokens: "10" },
    { output_tokens: -1 },
    { output_tokens: 0.5 },
    { input_tokens: 1_000_000_001 },
    { input_tokens: 1, input_cached_tokens: 2 },
    { output_tokens: 1, output_reasoning_tokens: 2 },
    { input_cached_tokens: null },
    { output_reasoning_tokens: "2" },
  ])
    assert.throws(() => inspect(json({ usage }), expected), rejected);
});

test("malformed/oversized UTF-8 input and invalid Unicode never echo upstream details", () => {
  for (const text of [
    "",
    "{upstream-secret",
    json() + "x",
    "😀".repeat(20000),
    json({ ignored: "x".repeat(65536) }),
    json({ ignored: "界".repeat(22000) }),
    json({ ignored: "\ud800" }),
    json() + "\udfff",
  ])
    assert.throws(
      () => inspect(text, expected),
      (error) =>
        error instanceof TypeError &&
        error.message === "Invalid native cost observation",
    );
  assert.throws(() => inspect(Buffer.from(json()), expected), rejected);
});

test("usage counters cannot round a fractional or exponential lexeme into an integer", () => {
  for (const literal of [
    "1.0000000000000000000000000001",
    "1e2",
    "-0",
    "1e400",
  ]) {
    const text = json().replace(
      '"input_tokens":22621',
      '"input_tokens":' + literal,
    );
    assert.throws(() => inspect(text, expected), rejected);
  }
  const boundary = json({
    usage: { input_tokens: 1_000_000_000, input_cached_tokens: 1_000_000_000 },
  });
  assert.equal(inspect(boundary, expected).usage.inputTokens, 1_000_000_000);
});

test("inspection performs no fetch and excludes unknown metadata, finality claims and secrets", (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    throw new Error("Forbidden network");
  });
  const payload = json({
    prompt: "synthetic-private-prompt",
    error: "synthetic-upstream-error",
    final: true,
    native_search_fees_included: true,
    tool_calls: 2,
    usage: { ...data().usage, secret: "synthetic-private-usage" },
  });
  const output = JSON.stringify(inspect(payload, expected));
  assert.doesNotMatch(
    output,
    /synthetic-private|synthetic-upstream|tool_calls|native_search_fees_included/,
  );
  assert.equal(JSON.parse(output).costFinality, "unknown");
  assert.equal(calls, 0);
});

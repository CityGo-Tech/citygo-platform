import test from "node:test";
import assert from "node:assert/strict";
import { parsePaymentAttempt, paymentAmountKopeks } from "./payment-attempt.js";

test("payment amount input converts exact decimal roubles without floating-point rounding", () => {
  for (const [input, expected] of [
    ["100", 10000],
    ["1", 100],
    ["100,01", 10001],
    ["1.1", 110],
    ["10000.00", 1000000],
  ] as const) {
    assert.equal(paymentAmountKopeks(input), expected);
  }
  for (const input of [
    "0.99",
    "10000.01",
    "-1",
    "1e2",
    "1.001",
    "",
    "Infinity",
    "1,2,3",
  ]) {
    assert.equal(paymentAmountKopeks(input), null);
  }
});

test("pending checkout recovery preserves the original idempotency key and amount", () => {
  const pending = {
    requestId: "4a7ecb31-0895-4b81-965b-69f47c6ce9e7",
    amountKopeks: 10000,
    orderId: "356c6b57-eb44-43c6-af7c-7e392a315aeb",
  };
  assert.deepEqual(parsePaymentAttempt(JSON.stringify(pending)), pending);
  assert.equal(parsePaymentAttempt(null), null);
  for (const value of [
    "null",
    "[]",
    "{",
    JSON.stringify({ ...pending, amountKopeks: 0 }),
    JSON.stringify({ ...pending, orderId: "not-an-id" }),
    JSON.stringify({ ...pending, token: "untrusted" }),
    "x".repeat(1001),
  ]) {
    assert.throws(() => parsePaymentAttempt(value));
  }
});

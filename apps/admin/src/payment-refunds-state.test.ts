import test from "node:test";
import assert from "node:assert/strict";
import {
  refundKopeks,
  sourceRefundable,
  refundCanSubmit,
  refundCanReconcile,
  refundMicros,
} from "./payment-refunds-state.js";

test("refund entry parses exact roubles with the explicit technical one-rouble minimum", () => {
  assert.equal(refundKopeks("1"), 100);
  assert.equal(refundKopeks("1,01"), 101);
  assert.equal(refundKopeks(" 100.1 "), 10010);
  for (const value of [
    "0.99",
    "-1",
    "1.001",
    "1e2",
    "Infinity",
    "10000001",
    "",
    "1 000",
  ])
    assert.equal(refundKopeks(value), null);
});
test("only test paid-source available money can be reserved; residual microunits never round up", () => {
  assert.equal(
    sourceRefundable({ test: true, availableMicros: 1_009_999 }, 101),
    false,
  );
  assert.equal(
    sourceRefundable({ test: true, availableMicros: 1_010_000 }, 101),
    true,
  );
  assert.equal(
    sourceRefundable({ test: false, availableMicros: 100_000_000 }, 100),
    false,
  );
  for (const amount of [null, 99, 100.1, NaN, Infinity])
    assert.equal(
      sourceRefundable({ test: true, availableMicros: 100_000_000 }, amount),
      false,
    );
});
test("unknown/pending/review never enable another dispatch or invent terminal success", () => {
  assert.equal(refundCanSubmit({ test: true, status: "reserved" }), true);
  for (const status of [
    "unknown",
    "pending",
    "review_required",
    "succeeded",
    "canceled",
  ] as const)
    assert.equal(refundCanSubmit({ test: true, status }), false);
  assert.equal(refundCanSubmit({ test: false, status: "reserved" }), false);
  assert.equal(
    refundCanReconcile({ test: true, status: "unknown", attemptCount: 1 }),
    true,
  );
  assert.equal(
    refundCanReconcile({ test: true, status: "reserved", attemptCount: 0 }),
    false,
  );
  assert.equal(
    refundCanReconcile({ test: false, status: "pending", attemptCount: 1 }),
    false,
  );
});
test("source balances retain all six decimal microunits for operator review", () => {
  assert.equal(refundMicros(1), "0,000001 ₽");
  assert.equal(refundMicros(100_000_000), "100,000000 ₽");
  assert.equal(refundMicros(-1), "—");
});

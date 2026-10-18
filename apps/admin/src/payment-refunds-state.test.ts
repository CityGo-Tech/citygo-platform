import test from "node:test";
import assert from "node:assert/strict";
import {
  refundKopeks,
  sourceRefundable,
  refundCanSubmit,
  refundCanReconcile,
  refundMicros,
  refundConfirmationText,
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
test("test and live paid-source available money can be reserved; residual microunits never round up", () => {
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
    true,
  );
  for (const testPayment of [true, false]) {
    for (const amount of [null, 99, 100.1, 1_000_000_001, NaN, Infinity])
      assert.equal(
        sourceRefundable(
          { test: testPayment, availableMicros: 100_000_000 },
          amount,
        ),
        false,
      );
    for (const availableMicros of [-1, 1_009_999, 1.5, NaN, Infinity])
      assert.equal(
        sourceRefundable({ test: testPayment, availableMicros }, 101),
        false,
      );
  }
  assert.equal(
    sourceRefundable(
      { test: undefined as unknown as boolean, availableMicros: 100_000_000 },
      100,
    ),
    false,
  );
});
test("unknown/pending/review never enable another dispatch or invent terminal success", () => {
  for (const testPayment of [true, false]) {
    assert.equal(
      refundCanSubmit({ test: testPayment, status: "reserved" }),
      true,
    );
    for (const status of [
      "unknown",
      "pending",
      "review_required",
      "succeeded",
      "canceled",
    ] as const)
      assert.equal(refundCanSubmit({ test: testPayment, status }), false);
    for (const status of ["unknown", "pending", "review_required"] as const)
      assert.equal(
        refundCanReconcile({ test: testPayment, status, attemptCount: 1 }),
        true,
      );
    for (const status of ["reserved", "succeeded", "canceled"] as const)
      assert.equal(
        refundCanReconcile({ test: testPayment, status, attemptCount: 1 }),
        false,
      );
    for (const attemptCount of [0, -1, 0.5, NaN, Infinity])
      assert.equal(
        refundCanReconcile({
          test: testPayment,
          status: "pending",
          attemptCount,
        }),
        false,
      );
  }
  assert.equal(
    refundCanSubmit({ test: "live" as unknown as boolean, status: "reserved" }),
    false,
  );
  assert.equal(
    refundCanReconcile({
      test: undefined as unknown as boolean,
      status: "pending",
      attemptCount: 1,
    }),
    false,
  );
});
test("source balances retain all six decimal microunits for operator review", () => {
  assert.equal(refundMicros(1), "0,000001 ₽");
  assert.equal(refundMicros(100_000_000), "100,000000 ₽");
  assert.equal(refundMicros(-1), "—");
});

test("live reservation and dispatch require distinct human acknowledgements without conflating settlement", () => {
  const reserve = refundConfirmationText(false, "reserve");
  const submit = refundConfirmationText(false, "submit");
  assert.notEqual(reserve, submit);
  assert.match(reserve, /боевого платежа/);
  assert.match(reserve, /Запрос ЮKassa не отправляется/);
  assert.match(submit, /Отдельно подтверждаю отправку/);
  assert.match(submit, /настоящие деньги/);
  assert.match(refundConfirmationText(true, "reserve"), /sandbox-платежа/);
  assert.match(refundConfirmationText(true, "submit"), /тестового возврата/);
});

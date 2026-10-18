import test from "node:test";
import assert from "node:assert/strict";
import { createReceiptPanelGuard, receiptMoney } from "./npd-receipts-state.js";

test("receipt detail selection rejects an earlier task without ending the session", () => {
  const guard = createReceiptPanelGuard();
  const session = guard.capture();
  const a = guard.select();
  const b = guard.select();
  assert.equal(a.active(), false);
  assert.throws(a.check, /Сессия клиента изменилась/);
  assert.equal(b.active(), true);
  assert.equal(session.active(), true);
});

test("receipt panel reset prevents stale list, detail and mutation results after logout or 403", () => {
  const guard = createReceiptPanelGuard();
  const list = guard.capture();
  const detail = guard.select();
  guard.reset();
  assert.equal(list.signal.aborted, true);
  assert.equal(detail.active(), false);
  assert.throws(list.check, /Сессия клиента изменилась/);
  assert.throws(detail.check, /Сессия клиента изменилась/);
  assert.equal(guard.select().active(), true);
});

test("receipt money displays only exact nonnegative kopeks", () => {
  assert.equal(receiptMoney(10000), "100,00 ₽");
  assert.equal(receiptMoney(1), "0,01 ₽");
  assert.equal(receiptMoney(0), "0,00 ₽");
  for (const amount of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(receiptMoney(amount), "—");
});

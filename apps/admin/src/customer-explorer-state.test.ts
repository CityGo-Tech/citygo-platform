import assert from "node:assert/strict";
import test from "node:test";
import { customerMoney } from "./customer-explorer-state.js";

test("customer balance preserves signed debt and exact sub-kopeck costs", () => {
  assert.equal(customerMoney(500_000_000), "500 ₽");
  assert.equal(customerMoney(1), "0,000001 ₽");
  assert.equal(customerMoney(-1), "−0,000001 ₽");
  assert.equal(customerMoney(-5_120_000), "−5,12 ₽");
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(customerMoney(value), "—");
});

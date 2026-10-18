import assert from "node:assert/strict";
import test from "node:test";
import {
  NpdReceiptPlanError,
  npdReceiptPlanSchema,
  parseNpdReceiptPlan,
} from "./npd-receipt-plan.js";

const manual = {
  schemaVersion: 1,
  fiscalFramework: "npd",
  paymentProvider: "yookassa",
  receiptProvider: "npd_manual",
} as const;

test("manual NPD plan separates payment acceptance from receipt preparation", () => {
  const plan = parseNpdReceiptPlan(manual);
  assert.deepEqual(plan, manual);
  assert.notEqual(plan, manual);
  assert.deepEqual(Object.keys(plan).sort(), [
    "fiscalFramework",
    "paymentProvider",
    "receiptProvider",
    "schemaVersion",
  ]);
});

test("future payment/receipt combinations are planning choices, not approvals or integrations", () => {
  for (const paymentProvider of ["yookassa", "robokassa"] as const) {
    for (const receiptProvider of ["npd_manual", "npd_partner"] as const) {
      const plan = parseNpdReceiptPlan({
        ...manual,
        paymentProvider,
        receiptProvider,
      });
      assert.equal(plan.paymentProvider, paymentProvider);
      assert.equal(plan.receiptProvider, receiptProvider);
      assert.equal("approved" in plan, false);
      assert.equal("readyForLive" in plan, false);
      assert.equal("receiptIssued" in plan, false);
    }
  }
});

test("there are no default provider choices, framework substitutions or coerced versions", () => {
  for (const key of Object.keys(manual)) {
    const incomplete: Record<string, unknown> = { ...manual };
    delete incomplete[key];
    assert.equal(npdReceiptPlanSchema.safeParse(incomplete).success, false);
  }
  for (const patch of [
    { schemaVersion: "1" },
    { schemaVersion: 2 },
    { fiscalFramework: "54fz_non_npd" },
    { fiscalFramework: "54fz" },
    { fiscalFramework: "NPD" },
    { paymentProvider: "npd_manual" },
    { receiptProvider: "yookassa" },
    { paymentProvider: "unknown" },
    { receiptProvider: "manual" },
  ]) {
    assert.equal(
      npdReceiptPlanSchema.safeParse({ ...manual, ...patch }).success,
      false,
    );
  }
});

test("authority, tax codes, credentials and receipt states are not part of the planning contract", () => {
  for (const patch of [
    { approved: true },
    { activationSupported: true },
    { readyForLive: true },
    { operatorTaxStatusVerified: true },
    { taxSystemCode: 2 },
    { vatCode: 1 },
    { receiptIssued: true },
    { paymentStatus: "succeeded" },
    { deliveryStatus: "delivered" },
    { secretKey: "PRIVATE_SYNTHETIC_KEY" },
    { email: "private.synthetic@example.test" },
  ]) {
    assert.equal(
      npdReceiptPlanSchema.safeParse({ ...manual, ...patch }).success,
      false,
    );
  }
});

test("the boundary helper never echoes unknown fields or rejected input", () => {
  const secret = "PRIVATE_SYNTHETIC_CONTACT_OR_CREDENTIAL";
  for (const input of [
    null,
    [],
    secret,
    { ...manual, [secret]: secret },
    { ...manual, receiptProvider: secret },
    { ...manual, fiscalFramework: secret },
  ]) {
    assert.throws(
      () => parseNpdReceiptPlan(input),
      (error: unknown) => {
        assert.ok(error instanceof NpdReceiptPlanError);
        assert.equal(error.code, "plan");
        assert.equal("cause" in error, false);
        assert.equal("issues" in error, false);
        assert.equal(
          (String(error) + JSON.stringify(error)).includes(secret),
          false,
        );
        return true;
      },
    );
  }
});

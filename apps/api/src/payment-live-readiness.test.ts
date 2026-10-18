import assert from "node:assert/strict";
import test from "node:test";
import { inspectLivePaymentPreparation } from "./payment-live-readiness.js";

const profile = {
  schemaVersion: 1,
  fiscalFramework: "54fz_non_npd",
  approved: true,
  approvalReference: "SYNTHETIC-OPERATOR-CHOICE-NOT-REAL-APPROVAL",
  cashSolution: "external",
  scenario: "payment_and_receipt",
  businessModel: "wallet_advance",
  itemDescription: "Synthetic advance",
  paymentSubject: "payment",
  paymentMode: "advance",
  vatCode: 1,
  taxSystemCode: 2,
  closingReceipts: {
    strategy: "on_each_service",
    workflowReference: "SYNTHETIC-CLOSING-RECEIPTS",
  },
};
const manualNpdPlan = {
  schemaVersion: 1,
  fiscalFramework: "npd",
  paymentProvider: "yookassa",
  receiptProvider: "npd_manual",
} as const;

test("empty preparation stays blocked with named operator and engineering gaps", () => {
  const result = inspectLivePaymentPreparation();
  assert.equal(result.readyForLive, false);
  assert.equal(result.activationSupported, false);
  assert.equal(result.operatorTaxRegime, "unknown");
  assert.ok(
    result.blockers.some((gap) => gap.code === "OPERATOR_TAX_REGIME_REQUIRED"),
  );
  assert.ok(
    result.blockers.some((gap) => gap.code === "SOURCE_POLICY_REQUIRED"),
  );
  assert.ok(
    result.blockers.some(
      (gap) => gap.code === "LIVE_MERCHANT_ACCEPTANCE_PENDING",
    ),
  );
});

test("all reported choices cannot turn a technical preview into live approval", () => {
  const result = inspectLivePaymentPreparation({
    fiscalProfile: profile,
    operatorTaxRegime: "non_npd",
    sourcePolicy: "gift_first_paid_fifo",
    merchantReceiptsReportedEnabled: true,
  });
  assert.equal(result.fiscalProfileTechnicallyValid, true);
  assert.equal(result.readyForLive, false);
  assert.equal(result.taxComplianceConfirmed, false);
  assert.equal(result.credentialsChecked, false);
  assert.equal(result.blockers.length, 4);
});

test("a valid but different sales model does not silently change the product", () => {
  const result = inspectLivePaymentPreparation({
    fiscalProfile: {
      ...profile,
      cashSolution: "yookassa",
      businessModel: "defined_service_prepayment",
      paymentSubject: "service",
      paymentMode: "full_prepayment",
    },
    operatorTaxRegime: "non_npd",
  });
  assert.equal(result.fiscalProfileTechnicallyValid, false);
  assert.ok(
    result.blockers.some((gap) => gap.code === "PRODUCT_FISCAL_MODEL_MISMATCH"),
  );
});

test("malformed profile or extraneous secrets never reach the readiness report", () => {
  for (const fiscalProfile of [
    { ...profile, vatCode: 99, PRIVATE: "PRIVATE-CONTACT-OR-KEY" },
    { ...profile, approvalEvidenceUrl: "not-a-url-PRIVATE-CONTACT-OR-KEY" },
    { ...profile, cashSolution: "yookassa" },
  ]) {
    const result = inspectLivePaymentPreparation({
      fiscalProfile,
      operatorTaxRegime: "non_npd",
    });
    assert.equal(result.fiscalProfileTechnicallyValid, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CONTACT-OR-KEY/);
  }
});

test("NPD cannot be inferred as a 54-FZ tax code or approved by a legacy profile", () => {
  for (const fiscalProfile of [
    undefined,
    profile,
    { ...profile, taxSystemCode: 1 },
  ]) {
    const result = inspectLivePaymentPreparation({
      operatorTaxRegime: "npd",
      sourcePolicy: "gift_first_paid_fifo",
      merchantReceiptsReportedEnabled: true,
      fiscalProfile,
    });
    assert.equal(result.operatorTaxRegime, "npd");
    assert.equal(result.fiscalProfileTechnicallyValid, false);
    assert.equal(result.readyForLive, false);
    assert.ok(
      result.blockers.some(
        (gap) => gap.code === "NPD_FISCAL_FLOW_NOT_IMPLEMENTED",
      ),
    );
    assert.equal(
      result.blockers.some((gap) => gap.code === "FISCAL_PROFILE_REQUIRED"),
      false,
    );
  }
});

test("unknown regime remains unknown even with valid tax codes, shop flags and approved source policy", () => {
  for (const operatorTaxRegime of [
    undefined,
    "unknown",
    "NPD",
    "USN",
    2,
    true,
  ]) {
    const result = inspectLivePaymentPreparation({
      operatorTaxRegime,
      fiscalProfile: profile,
      sourcePolicy: "gift_first_paid_fifo",
      merchantReceiptsReportedEnabled: true,
    });
    assert.equal(result.operatorTaxRegime, "unknown");
    assert.equal(result.fiscalProfileTechnicallyValid, false);
    assert.ok(
      result.blockers.some(
        (gap) => gap.code === "OPERATOR_TAX_REGIME_REQUIRED",
      ),
    );
  }
});

test("non-NPD requires explicit framework and cannot accept NPD as numeric tax system", () => {
  for (const fiscalProfile of [
    { ...profile, fiscalFramework: undefined },
    { ...profile, fiscalFramework: "npd" },
    { ...profile, taxSystemCode: "npd" },
  ]) {
    const result = inspectLivePaymentPreparation({
      operatorTaxRegime: "non_npd",
      fiscalProfile,
    });
    assert.equal(result.fiscalProfileTechnicallyValid, false);
    assert.ok(
      result.blockers.some((gap) => gap.code === "FISCAL_PROFILE_REQUIRED"),
    );
  }
});

test("manual NPD plan removes the partner requirement without approving the live receipt flow", () => {
  const result = inspectLivePaymentPreparation({
    operatorTaxRegime: "npd",
    sourcePolicy: "gift_first_paid_fifo",
    npdReceiptPlan: manualNpdPlan,
  });
  assert.equal(result.npdReceiptPlanTechnicallyValid, true);
  assert.deepEqual(result.npdReceiptPlan, manualNpdPlan);
  assert.equal(result.fiscalProfileTechnicallyValid, false);
  assert.equal(result.taxComplianceConfirmed, false);
  assert.equal(result.readyForLive, false);
  assert.equal(result.activationSupported, false);
  assert.equal(result.credentialsChecked, false);
  assert.deepEqual(
    result.blockers.map((gap) => gap.code),
    [
      "MANUAL_RECEIPT_LIVE_ACCEPTANCE_PENDING",
      "LIVE_MERCHANT_ACCEPTANCE_PENDING",
      "FISCAL_WORKFLOW_LIVE_ACCEPTANCE_PENDING",
      "BACKGROUND_RECONCILIATION_RELEASE_PENDING",
      "LIVE_RELEASE_PROFILE_NOT_IMPLEMENTED",
    ],
  );
});

test("legacy merchant receipt flags neither block nor approve the manual NPD plan", () => {
  const input = {
    operatorTaxRegime: "npd",
    sourcePolicy: "gift_first_paid_fifo",
    npdReceiptPlan: manualNpdPlan,
  };
  const baseline = inspectLivePaymentPreparation(input);
  for (const merchantReceiptsReportedEnabled of [true, false]) {
    assert.deepEqual(
      inspectLivePaymentPreparation({
        ...input,
        merchantReceiptsReportedEnabled,
      }),
      baseline,
    );
  }
});

test("future payment and receipt providers remain unimplemented independently", () => {
  for (const paymentProvider of ["yookassa", "robokassa"] as const) {
    for (const receiptProvider of ["npd_manual", "npd_partner"] as const) {
      const plan = { ...manualNpdPlan, paymentProvider, receiptProvider };
      const result = inspectLivePaymentPreparation({
        operatorTaxRegime: "npd",
        sourcePolicy: "gift_first_paid_fifo",
        npdReceiptPlan: plan,
      });
      assert.equal(result.npdReceiptPlanTechnicallyValid, true);
      assert.deepEqual(result.npdReceiptPlan, plan);
      assert.equal(result.readyForLive, false);
      assert.equal(result.activationSupported, false);
      assert.equal(
        result.blockers.some(
          (gap) => gap.code === "ROBOKASSA_PAYMENT_FLOW_NOT_IMPLEMENTED",
        ),
        paymentProvider === "robokassa",
      );
      assert.equal(
        result.blockers.some(
          (gap) => gap.code === "NPD_PARTNER_RECEIPT_FLOW_NOT_IMPLEMENTED",
        ),
        receiptProvider === "npd_partner",
      );
      assert.ok(
        result.blockers.some(
          (gap) => gap.code === "LIVE_MERCHANT_ACCEPTANCE_PENDING",
        ),
      );
    }
  }
});

test("invalid NPD plans reject authority/framework substitutions and hide secret fields", () => {
  const secret = "PRIVATE_SYNTHETIC_CONTACT_OR_CREDENTIAL";
  for (const npdReceiptPlan of [
    undefined,
    profile,
    { ...manualNpdPlan, fiscalFramework: "54fz_non_npd" },
    { ...manualNpdPlan, approved: true },
    { ...manualNpdPlan, [secret]: secret },
    { ...manualNpdPlan, receiptProvider: secret },
  ]) {
    const result = inspectLivePaymentPreparation({
      operatorTaxRegime: "npd",
      npdReceiptPlan,
    });
    assert.equal(result.npdReceiptPlanTechnicallyValid, false);
    assert.equal(result.npdReceiptPlan, null);
    assert.ok(
      result.blockers.some(
        (gap) => gap.code === "NPD_FISCAL_FLOW_NOT_IMPLEMENTED",
      ),
    );
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal(result.readyForLive, false);
  }
});

test("planning an NPD receipt does not infer or change the operator tax regime", () => {
  for (const operatorTaxRegime of ["unknown", "non_npd"] as const) {
    const result = inspectLivePaymentPreparation({
      operatorTaxRegime,
      npdReceiptPlan: manualNpdPlan,
      fiscalProfile: profile,
    });
    assert.equal(result.operatorTaxRegime, operatorTaxRegime);
    assert.equal(result.npdReceiptPlanTechnicallyValid, false);
    assert.equal(result.npdReceiptPlan, null);
    assert.ok(
      result.blockers.some(
        (gap) => gap.code === "NPD_RECEIPT_PLAN_REGIME_MISMATCH",
      ),
    );
    assert.equal(result.readyForLive, false);
  }
});

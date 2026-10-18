import test from "node:test";
import assert from "node:assert/strict";
import {
  PaymentFiscalError,
  assertFiscalReceiptTotal,
  buildPaymentReceipt,
  formatFiscalRub,
  parsePaymentFiscalCustomer,
  parsePaymentFiscalProfile,
  paymentFiscalProfileSchema,
} from "./payment-fiscal.js";

const advance = {
  schemaVersion: 1,
  fiscalFramework: "54fz_non_npd",
  approved: true,
  approvalReference: "SYNTHETIC-APPROVAL-NOT-LEGAL-ADVICE",
  approvalEvidenceUrl: "https://example.test/fiscal-policy",
  cashSolution: "external",
  scenario: "payment_and_receipt",
  businessModel: "wallet_advance",
  itemDescription: "Аванс за услуги CityGo",
  paymentSubject: "payment",
  paymentMode: "advance",
  vatCode: 1,
  taxSystemCode: 2,
  closingReceipts: {
    strategy: "on_each_service",
    workflowReference: "SYNTHETIC-CLOSING-WORKFLOW",
  },
} as const;
const prepayment = {
  ...advance,
  cashSolution: "yookassa",
  businessModel: "defined_service_prepayment",
  itemDescription: "Предоплата определённой услуги CityGo",
  paymentSubject: "service",
  paymentMode: "full_prepayment",
} as const;
const customer = { email: "synthetic@example.test" };

test("fiscal profile has no implied approval, tax or closing choices", () => {
  assert.deepEqual(parsePaymentFiscalProfile(advance), advance);
  for (const key of Object.keys(advance)) {
    if (key === "approvalEvidenceUrl") continue;
    const incomplete: Record<string, unknown> = { ...advance };
    delete incomplete[key];
    assert.equal(
      paymentFiscalProfileSchema.safeParse(incomplete).success,
      false,
    );
  }
  for (const closingReceipts of [
    undefined,
    {},
    { strategy: "none", workflowReference: "not-approved" },
    { strategy: "on_each_service", workflowReference: " " },
  ]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, closingReceipts })
        .success,
      false,
    );
  }
  for (const approved of [false, "true", undefined]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, approved }).success,
      false,
    );
  }
  assert.equal(
    paymentFiscalProfileSchema.safeParse({ ...advance, approvalReference: " " })
      .success,
    false,
  );
});

test("unallocated wallet advance cannot masquerade as built-in full prepayment", () => {
  for (const delta of [
    { cashSolution: "yookassa" },
    { paymentMode: "full_prepayment" },
    { paymentSubject: "service" },
    { businessModel: "defined_service_prepayment" },
  ]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, ...delta }).success,
      false,
    );
  }
  assert.equal(paymentFiscalProfileSchema.safeParse(prepayment).success, true);
  for (const scenario of ["receipt_then_payment", "payment_then_receipt"]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...prepayment, scenario }).success,
      false,
    );
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, scenario }).success,
      true,
    );
  }
  for (const paymentMode of ["full_payment", "partial_prepayment", "credit"]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, paymentMode }).success,
      false,
    );
  }
});

test("provider VAT whitelist includes 2026 codes 11 and 12 without selecting a tax", () => {
  for (const vatCode of Array.from({ length: 12 }, (_, index) => index + 1)) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, vatCode }).success,
      true,
    );
  }
  for (const vatCode of [0, 13, 1.5, "1", NaN, Infinity]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, vatCode }).success,
      false,
    );
  }
  for (const taxSystemCode of [0, 7, 1.5, "2", undefined]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, taxSystemCode })
        .success,
      false,
    );
  }
});

test("54-FZ preview does not silently map NPD or an unspecified framework to a tax code", () => {
  for (const fiscalFramework of ["npd", "422fz", "54fz", undefined, null]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, fiscalFramework })
        .success,
      false,
    );
    assert.throws(
      () =>
        buildPaymentReceipt({
          profile: { ...advance, fiscalFramework },
          customer,
          amountKopeks: 100,
        }),
      PaymentFiscalError,
    );
  }
});

test("fiscal evidence rejects malformed URLs and unknown fields at every boundary", () => {
  for (const approvalEvidenceUrl of [
    "not a URL",
    "https://[invalid",
    "http://example.test/policy",
    "javascript:alert(1)",
    "https://login:password@example.test/policy",
    "https://example.test/policy?email=private@example.test",
    "https://example.test/policy#private",
  ]) {
    assert.equal(
      paymentFiscalProfileSchema.safeParse({ ...advance, approvalEvidenceUrl })
        .success,
      false,
    );
  }
  assert.equal(
    paymentFiscalProfileSchema.safeParse({ ...advance, enableLive: true })
      .success,
    false,
  );
  assert.equal(
    paymentFiscalProfileSchema.safeParse({
      ...advance,
      closingReceipts: { ...advance.closingReceipts, automaticApproval: true },
    }).success,
    false,
  );
  assert.throws(() =>
    parsePaymentFiscalCustomer({ ...customer, phone: "+70000000000" }),
  );
  assert.throws(() =>
    buildPaymentReceipt({
      profile: advance,
      customer,
      amountKopeks: 100,
      live: true,
    }),
  );
});

test("exact fiscal money formatting never uses float rounding or exponential notation", () => {
  for (const [input, expected] of [
    [1, "0.01"],
    [10, "0.10"],
    [99, "0.99"],
    [100, "1.00"],
    [10_000, "100.00"],
    [Number.MAX_SAFE_INTEGER, "90071992547409.91"],
  ] as const) {
    assert.equal(formatFiscalRub(input), expected);
  }
  for (const value of [
    0,
    -1,
    0.5,
    100.001,
    Infinity,
    NaN,
    "100",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => formatFiscalRub(value), PaymentFiscalError);
  }
});

test("offline receipt builder preserves explicit advance and distinct service prepayment", () => {
  const plan = buildPaymentReceipt({
    profile: advance,
    customer,
    amountKopeks: 10_001,
  });
  assert.equal(plan.purpose, "offline_preview_only");
  assert.deepEqual(plan.profile, advance);
  assert.deepEqual(plan.receipt, {
    customer,
    items: [
      {
        description: advance.itemDescription,
        quantity: "1.000",
        amount: { value: "100.01", currency: "RUB" },
        vat_code: 1,
        payment_mode: "advance",
        payment_subject: "payment",
        measure: "piece",
      },
    ],
    tax_system_code: 2,
  });
  const servicePlan = buildPaymentReceipt({
    profile: prepayment,
    customer,
    amountKopeks: 100,
  });
  assert.equal(servicePlan.receipt.items[0]?.payment_mode, "full_prepayment");
  assert.equal(servicePlan.receipt.items[0]?.payment_subject, "service");
  assert.equal("tax_system_code" in servicePlan.receipt, false);
  assert.equal(servicePlan.profile.taxSystemCode, 2);
});

test("receipt total is exact and rejects extra items, fields, quantities and malformed amounts", () => {
  const { receipt } = buildPaymentReceipt({
    profile: advance,
    customer,
    amountKopeks: 100,
  });
  assert.deepEqual(assertFiscalReceiptTotal(receipt, 100), receipt);
  assert.throws(
    () => assertFiscalReceiptTotal(receipt, 99),
    PaymentFiscalError,
  );
  assert.throws(
    () => assertFiscalReceiptTotal({ ...receipt, unexpected: true }, 100),
    PaymentFiscalError,
  );
  for (const amount of [
    { value: "01.00", currency: "RUB" },
    { value: "1", currency: "RUB" },
    { value: "1.000", currency: "RUB" },
    { value: "1e2", currency: "RUB" },
    { value: "-1.00", currency: "RUB" },
    { value: "0.00", currency: "RUB" },
    { value: "90071992547409.92", currency: "RUB" },
    { value: "1.00", currency: "USD" },
  ]) {
    assert.throws(
      () =>
        assertFiscalReceiptTotal(
          {
            ...receipt,
            items: [{ ...receipt.items[0], amount }],
          },
          100,
        ),
      PaymentFiscalError,
    );
  }
  for (const items of [
    [],
    [...receipt.items, ...receipt.items],
    [{ ...receipt.items[0], quantity: "2.000" }],
  ]) {
    assert.throws(
      () => assertFiscalReceiptTotal({ ...receipt, items }, 100),
      PaymentFiscalError,
    );
  }
});

test("public fiscal helpers never embed customer PII or rejected input in errors", () => {
  const secret = "private.customer@example.test";
  const actions = [
    () => parsePaymentFiscalProfile({ ...advance, [secret]: "hidden" }),
    () => parsePaymentFiscalCustomer({ email: secret, extra: secret }),
    () => parsePaymentFiscalCustomer({ email: `${secret} not-an-email` }),
    () =>
      buildPaymentReceipt({
        profile: {
          ...advance,
          approvalEvidenceUrl: `https://example.test/?email=${secret}`,
        },
        customer,
        amountKopeks: 100,
      }),
    () =>
      assertFiscalReceiptTotal({ customer: { email: secret }, items: [] }, 100),
  ];
  for (const action of actions) {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof PaymentFiscalError);
      assert.equal(
        `${String(error)}${JSON.stringify(error)}`.includes(secret),
        false,
      );
      assert.equal("cause" in error, false);
      return true;
    });
  }
});

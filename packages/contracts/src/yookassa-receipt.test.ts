import assert from "node:assert/strict";
import test from "node:test";
import { createTopupSchema } from "./payments.js";
import {
  YOOKASSA_RECEIPT_PROFILE,
  YooKassaReceiptError,
  assertYooKassaReceiptTotal,
  buildYooKassaReceipt,
  parseYooKassaReceipt,
  yooKassaReceiptEmailSchema,
} from "./yookassa-receipt.js";

const email = "buyer@citygo-mail.ru";
test("explicit operator receipt profile is deterministic and contains no inferred tax regime", () => {
  const input = { email, amountKopeks: 10_001 };
  assert.equal(YOOKASSA_RECEIPT_PROFILE, "citygo_service_full_payment_v1");
  const expected = {
    customer: { email },
    items: [
      {
        description: "Пополнение баланса CityGo",
        quantity: "1.000",
        amount: { value: "100.01", currency: "RUB" },
        vat_code: 1,
        payment_subject: "service",
        payment_mode: "full_payment",
        measure: "piece",
      },
    ],
  };
  assert.deepEqual(buildYooKassaReceipt(input), expected);
  assert.deepEqual(buildYooKassaReceipt(input), expected);
  assert.equal("tax_system_code" in buildYooKassaReceipt(input), false);
  assert.equal(
    buildYooKassaReceipt({ ...input, test: true }).items[0]!.description,
    "Пополнение тестового баланса CityGo",
  );
});
test("exact integer kopeks formatting covers one kopek and the upper bound", () => {
  for (const [amountKopeks, value] of [
    [1, "0.01"],
    [101, "1.01"],
    [100, "1.00"],
    [1_000_000_000, "10000000.00"],
  ] as const) {
    const receipt = buildYooKassaReceipt({ email, amountKopeks });
    assert.equal(receipt.items[0]!.amount.value, value);
    assert.deepEqual(
      assertYooKassaReceiptTotal(receipt, amountKopeks),
      receipt,
    );
  }
});
test("invalid email, synthetic domains, amounts and extra builder tax choices fail privately", () => {
  for (const bad of [
    "admin@citygo.invalid",
    "user@localhost",
    "user@host.localhost",
    "buyer@example.com",
    "buyer@EXAMPLE.ORG",
    "buyer@test.invalid",
    "buyer@citygo.test",
    "buyer@citygo.example",
    "a\r\nPRIVATE@citygo.ru",
    "PRIVATE",
    "a@b.ru\n",
    " buyer@citygo-mail.ru",
  ]) {
    assert.equal(yooKassaReceiptEmailSchema.safeParse(bad).success, false);
    assert.throws(
      () => buildYooKassaReceipt({ email: bad, amountKopeks: 100 }),
      (e: unknown) =>
        e instanceof YooKassaReceiptError &&
        !String(e).includes(bad) &&
        !JSON.stringify(e).includes(bad),
    );
  }
  for (const amountKopeks of [
    0,
    -1,
    1.1,
    NaN,
    Infinity,
    1_000_000_001,
    "100",
    null,
  ])
    assert.throws(
      () => buildYooKassaReceipt({ email, amountKopeks }),
      YooKassaReceiptError,
    );
  for (const extra of [
    { vat_code: 2 },
    { tax_system_code: 1 },
    { approved: true },
    { agent_info: { type: "agent" } },
    { test: "true" },
  ])
    assert.throws(
      () => buildYooKassaReceipt({ email, amountKopeks: 100, ...extra }),
      YooKassaReceiptError,
    );
});
test("strict receipt schema rejects injected fields, semantic substitution and mismatched totals", () => {
  const receipt = buildYooKassaReceipt({ email, amountKopeks: 100 });
  for (const changed of [
    { ...receipt, tax_system_code: 1 },
    { ...receipt, customer: { email, phone: "PRIVATE" } },
    { ...receipt, items: [...receipt.items, ...receipt.items] },
    ...[
      { vat_code: 2 },
      { payment_mode: "advance" },
      { payment_subject: "payment" },
      { quantity: "2.000" },
      { measure: "another" },
      { description: "PRIVATE arbitrary service" },
      { agent_info: { type: "agent" } },
      { amount: { value: "01.00", currency: "RUB" } },
      { amount: { value: "1e0", currency: "RUB" } },
    ].map((patch) => ({
      ...receipt,
      items: [{ ...receipt.items[0], ...patch }],
    })),
  ])
    assert.throws(() => parseYooKassaReceipt(changed), YooKassaReceiptError);
  assert.throws(
    () => assertYooKassaReceiptTotal(receipt, 101),
    YooKassaReceiptError,
  );
});
test("parse snapshots detach every nested caller field; DTO accepts only optional validated email", () => {
  const receipt = buildYooKassaReceipt({ email, amountKopeks: 100 });
  const parsed = parseYooKassaReceipt(receipt);
  receipt.customer.email = "other@citygo-mail.ru";
  receipt.items[0]!.amount.value = "2.00";
  assert.equal(parsed.customer.email, email);
  assert.equal(parsed.items[0]!.amount.value, "1.00");
  const base = {
    requestId: "2419a771-000f-4000-9000-1edaf29243f2",
    amountKopeks: 100,
  };
  assert.equal(createTopupSchema.safeParse(base).success, true);
  assert.equal(
    createTopupSchema.safeParse({ ...base, receiptEmail: email }).success,
    true,
  );
  assert.equal(
    createTopupSchema.safeParse({
      ...base,
      receiptEmail: "admin@citygo.invalid",
    }).success,
    false,
  );
  assert.equal(
    createTopupSchema.safeParse({ ...base, receipt: { customer: { email } } })
      .success,
    false,
  );
});

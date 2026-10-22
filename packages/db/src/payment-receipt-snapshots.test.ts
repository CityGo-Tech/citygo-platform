import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { AiCreditLedger } from "./ai-credit.js";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { PaymentRefunds } from "./payment-refunds.js";
import { DomainError, Repository, connectDatabase, migrate } from "./index.js";

const profile = "citygo_service_full_payment_v1" as const;
const receiptEmail = "receipt@citygo-synthetic.ru";
const returnUrl = "https://citygo.example.test/";
const conflict = (value: unknown) =>
  value instanceof DomainError && value.statusCode === 409;
type MutableReceiptFixture = {
  receipt: {
    items: { vat_code: number; amount: { value: string } }[];
    tax_system_code?: number;
    customer: { email: string };
  };
};
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db);
  const user = await repo.register("account@example.test", "SYNTHETIC-HASH");
  const operator = await repo.register(
    "operator@example.test",
    "SYNTHETIC-HASH",
  );
  await db.query("update users set role='super_admin' where id=$1", [operator]);
  const ctx = { userId: operator, sessionTokenHash: "a".repeat(64) };
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
    [ctx.sessionTokenHash, operator],
  );
  const orders = new PaymentTopupOrders(db),
    ledger = new AiCreditLedger(db),
    refunds = new PaymentRefunds(db);
  const create = (requestId = randomUUID(), email = receiptEmail) =>
    orders.create(user, requestId, 10_000, "12345", false, returnUrl, {
      receiptEmail: email,
      receiptProfile: profile,
    });
  const paid = async () => {
    const order = await create(),
      payment = randomUUID();
    await orders.recordProvider(user, order.id, {
      providerPaymentId: payment,
      status: "pending",
    });
    await db.query(
      "update user_credentials set email='changed@citygo-synthetic.ru' where user_id=$1",
      [user],
    );
    await ledger.topUpConfirmed(user, order.id, {
      providerPaymentId: payment,
      paidKopeks: 10_000,
      merchantId: "12345",
      test: false,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    return { order, payment };
  };
  return { db, user, operator, ctx, orders, ledger, refunds, create, paid };
}

test("receipt order snapshot precedes provider I/O, owner recovery and replays preserve the exact body", async (t) => {
  const f = await fixture(t),
    request = randomUUID();
  const first = await f.create(request);
  assert.equal(first.payloadVersion, 2);
  assert.equal(first.receiptEmail, receiptEmail);
  assert.equal(first.receiptProfile, profile);
  assert.equal(first.createPayload.receipt!.customer.email, receiptEmail);
  assert.equal(first.createPayload.receipt!.items[0]!.amount.value, "100.00");
  assert.equal(first.status, "queued");
  assert.equal(first.providerPaymentId, null);
  assert.equal(first.credited, false);
  assert.deepEqual(await f.create(request), first);
  assert.deepEqual(await f.orders.getByRequestId(f.user, request), first);
  await assert.rejects(
    f.orders.getByRequestId(f.operator, request),
    (e: unknown) => e instanceof DomainError && e.statusCode === 404,
  );
  await assert.rejects(
    f.create(request, "other@citygo-synthetic.ru"),
    conflict,
  );
  await assert.rejects(
    f.orders.create(f.user, request, 10_001, "12345", false, returnUrl, {
      receiptEmail,
      receiptProfile: profile,
    }),
    conflict,
  );
  await assert.rejects(
    f.orders.create(f.user, request, 10_000, "12345", false, returnUrl),
    conflict,
  );
  const legacy = await f.orders.create(
    f.user,
    randomUUID(),
    10_000,
    "12345",
    false,
    returnUrl,
  );
  assert.equal(legacy.payloadVersion, 1);
  assert.equal(legacy.receiptEmail, null);
  assert.equal("receipt" in legacy.createPayload, false);
  await assert.rejects(
    f.orders.create(
      f.user,
      legacy.requestId,
      10_000,
      "12345",
      false,
      returnUrl,
      { receiptEmail, receiptProfile: profile },
    ),
    conflict,
  );
  assert.deepEqual(
    (await f.orders.get(f.user, legacy.id)).createPayload,
    legacy.createPayload,
  );
});

test("receipt snapshots are immutable and DB insertion refuses noncanonical, reserved or mismatched receipts", async (t) => {
  const f = await fixture(t),
    order = await f.create();
  for (const sql of [
    "receipt_email='changed@citygo-synthetic.ru'",
    "receipt_profile='different'",
    "payload_version=1",
    "create_payload=create_payload||'{\"receipt\":{}}'::jsonb",
  ])
    await assert.rejects(
      f.db.query("update payment_topup_orders set " + sql + " where id=$1", [
        order.id,
      ]),
    );
  for (const change of [
    (p: MutableReceiptFixture) => (p.receipt.items[0]!.vat_code = 2),
    (p: MutableReceiptFixture) => (p.receipt.tax_system_code = 2),
    (p: MutableReceiptFixture) => (p.receipt.items[0]!.amount.value = "99.99"),
    (p: MutableReceiptFixture) =>
      (p.receipt.customer.email = "wrong@citygo-synthetic.ru"),
  ]) {
    const id = randomUUID(),
      payload = structuredClone(order.createPayload);
    payload.metadata.citygo_order_id = id;
    change(payload as unknown as MutableReceiptFixture);
    await assert.rejects(
      f.db.query(
        `insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload,
      payload_version,receipt_email,receipt_profile) values($1,$2,$3,10000,'12345',false,$4,$5,2,$6,$7)`,
        [
          id,
          f.user,
          randomUUID(),
          returnUrl,
          JSON.stringify(payload),
          receiptEmail,
          profile,
        ],
      ),
    );
  }
  await assert.rejects(
    f.create(randomUUID(), "admin@citygo.invalid"),
    (e: unknown) => e instanceof DomainError && e.statusCode === 400,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::integer as n from payment_topup_orders",
      )
    ).rows[0]!.n,
    1,
  );
});

test("NPD tasks and partial refund receipts use the original immutable payer email despite account edits", async (t) => {
  const f = await fixture(t),
    { order } = await f.paid();
  assert.equal(
    (
      await f.db.query<{ buyer_email: string }>(
        "select buyer_email from npd_receipt_tasks where id=$1",
        [order.id],
      )
    ).rows[0]!.buyer_email,
    receiptEmail,
  );
  await assert.rejects(
    f.db.query(
      `insert into npd_receipt_tasks(id,user_id,payment_id,merchant_id,amount_kopeks,buyer_email,observed_at)
    select id,user_id,payment_id,merchant_id,amount_kopeks,'wrong@citygo-synthetic.ru',observed_at from npd_receipt_tasks where id=$1`,
      [order.id],
    ),
    /exact live topup source/,
  );
  const requestId = randomUUID(),
    first = await f.refunds.create(f.ctx, {
      requestId,
      paymentOperationId: order.id,
      amountKopeks: 2345,
    });
  const row = (
    await f.db.query<{
      payload_version: number;
      receipt_email: string;
      create_payload: { receipt: typeof order.createPayload.receipt };
    }>(
      "select payload_version,receipt_email,create_payload from payment_refunds where id=$1",
      [first.refund.id],
    )
  ).rows[0]!;
  assert.equal(row.payload_version, 2);
  assert.equal(row.receipt_email, receiptEmail);
  const expected = structuredClone(order.createPayload.receipt!);
  expected.items[0]!.amount.value = "23.45";
  assert.deepEqual(row.create_payload.receipt, expected);
  assert.deepEqual(
    await f.refunds.create(f.ctx, {
      requestId,
      paymentOperationId: order.id,
      amountKopeks: 2345,
    }),
    first,
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 23_450_000);
  const dispatch = await f.refunds.prepareDispatch(f.ctx, first.refund.id, {
    merchantId: "12345",
    test: false,
  });
  assert.deepEqual(dispatch.dispatch!.input.createPayload, row.create_payload);
  assert.deepEqual(dispatch.dispatch!.input.receipt, expected);
  await assert.rejects(
    f.db.query(
      "update payment_refunds set receipt_email='changed@citygo-synthetic.ru' where id=$1",
      [first.refund.id],
    ),
  );
  await assert.rejects(
    f.db.query(
      "update payment_refunds set create_payload=create_payload-'receipt',revision=revision+1 where id=$1",
      [first.refund.id],
    ),
  );
});

test("full original-payment refund omits receipt but keeps immutable v2 receipt provenance", async (t) => {
  const f = await fixture(t),
    { order } = await f.paid();
  const created = await f.refunds.create(f.ctx, {
    requestId: randomUUID(),
    paymentOperationId: order.id,
    amountKopeks: 10_000,
  });
  const row = (
    await f.db.query<{
      payload_version: number;
      receipt_email: string;
      receipt_profile: string;
      create_payload: object;
    }>(
      "select payload_version,receipt_email,receipt_profile,create_payload from payment_refunds where id=$1",
      [created.refund.id],
    )
  ).rows[0]!;
  assert.equal(row.payload_version, 2);
  assert.equal(row.receipt_email, receiptEmail);
  assert.equal(row.receipt_profile, profile);
  assert.equal("receipt" in row.create_payload, false);
  const dispatch = await f.refunds.prepareDispatch(f.ctx, created.refund.id, {
    merchantId: "12345",
    test: false,
  });
  assert.deepEqual(dispatch.dispatch!.input.createPayload, row.create_payload);
  assert.equal(dispatch.dispatch!.input.receipt, undefined);
});

test("refund of the remaining balance after an earlier partial refund still includes partial-receipt items", async (t) => {
  const f = await fixture(t),
    { order, payment } = await f.paid();
  const first = await f.refunds.create(f.ctx, {
    requestId: randomUUID(),
    paymentOperationId: order.id,
    amountKopeks: 2500,
  });
  await f.refunds.recordObservation(first.refund.id, {
    id: randomUUID(),
    refundRequestId: first.refund.id,
    paymentId: payment,
    orderId: order.id,
    merchantId: "12345",
    test: false,
    amountKopeks: 2500,
    refundedAmountKopeks: 2500,
    currency: "RUB",
    status: "succeeded",
    observation: "server_get",
    verifiedAt: new Date().toISOString(),
  });
  const remainder = await f.refunds.create(f.ctx, {
    requestId: randomUUID(),
    paymentOperationId: order.id,
    amountKopeks: 7500,
  });
  const dispatch = await f.refunds.prepareDispatch(f.ctx, remainder.refund.id, {
    merchantId: "12345",
    test: false,
  });
  assert.equal(dispatch.dispatch!.input.refundedBeforeKopeks, 2500);
  assert.equal(
    dispatch.dispatch!.input.receipt!.items[0]!.amount.value,
    "75.00",
  );
  assert.equal(dispatch.dispatch!.input.receipt!.customer.email, receiptEmail);
});

test("legacy v1 checkout retains original NPD account-email fallback", async (t) => {
  const f = await fixture(t),
    order = await f.orders.create(
      f.user,
      randomUUID(),
      10_000,
      "12345",
      false,
      returnUrl,
    ),
    payment = randomUUID();
  await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
  });
  await f.db.query(
    "update user_credentials set email='legacy@citygo-synthetic.ru' where user_id=$1",
    [f.user],
  );
  await f.ledger.topUpConfirmed(f.user, order.id, {
    providerPaymentId: payment,
    paidKopeks: 10_000,
    merchantId: "12345",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  assert.equal(
    (
      await f.db.query<{ buyer_email: string }>(
        "select buyer_email from npd_receipt_tasks where id=$1",
        [order.id],
      )
    ).rows[0]!.buyer_email,
    "legacy@citygo-synthetic.ru",
  );
});

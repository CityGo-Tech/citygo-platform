import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { type AiCredit, type YooKassaReceipt } from "@citygo/contracts";
import { connectDatabase, migrate, PaymentAdmission } from "@citygo/db";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { createPaymentAdmissionBinding } from "./payment-admission.js";
import { YooKassaRefundClient } from "./yookassa-refunds.js";
import { YooKassaClient } from "./yookassa.js";

const origin = "https://pilot.example.test";
const merchant = "123456";
const receiptEmail = "receipt-buyer@synthetic-citygo-mail.ru";
const money = (kopeks: number) => ({
  value: `${Math.floor(kopeks / 100)}.${String(kopeks % 100).padStart(2, "0")}`,
  currency: "RUB",
});

// Both production transports use this injected fetch. No request can reach a
// payment provider, real credential, external DB, AI or environment file.
async function fixture() {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const state = {
    paymentPaid: false,
    refundedKopeks: 0,
    calls: [] as { method: string; path: string }[],
    paymentBodies: [] as { receipt: YooKassaReceipt }[],
    refundBodies: [] as { receipt?: YooKassaReceipt }[],
  };
  const paymentId = randomUUID();
  const refundId = randomUUID();
  let paymentBody: {
    amount: { value: string; currency: string };
    metadata: { citygo_order_id: string };
    receipt: YooKassaReceipt;
  };
  let refundBody: {
    amount: { value: string; currency: string };
    metadata: { citygo_refund_id: string };
    payment_id: string;
    receipt?: YooKassaReceipt;
  };
  const json = (data: unknown) => Response.json(data);
  const payment = () => ({
    id: paymentId,
    amount: paymentBody.amount,
    metadata: paymentBody.metadata,
    status: state.paymentPaid ? "succeeded" : "pending",
    paid: state.paymentPaid,
    test: false,
    recipient: { account_id: merchant },
    refundable: state.refundedKopeks < 10_000,
    refunded_amount: money(state.refundedKopeks),
    receipt_registration: "pending",
    ...(!state.paymentPaid
      ? {
          confirmation: {
            type: "redirect",
            confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${paymentId}`,
          },
        }
      : {}),
  });
  const refund = () => ({
    id: refundId,
    payment_id: paymentId,
    amount: refundBody.amount,
    metadata: refundBody.metadata,
    status: "succeeded",
    receipt_registration: "pending",
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.yookassa.ru");
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    state.calls.push({ method, path });
    if (method === "POST" && path === "/v3/payments") {
      paymentBody = JSON.parse(String(init?.body));
      const saved = (
        await db.query<{ create_payload: unknown }>(
          "select create_payload from payment_topup_orders where id=$1",
          [paymentBody.metadata.citygo_order_id],
        )
      ).rows[0];
      assert.ok(saved, "payment is durable before its monetary POST");
      assert.deepEqual(paymentBody, saved.create_payload);
      assert.equal(paymentBody.receipt.customer.email, receiptEmail);
      assert.equal(
        new Headers(init?.headers).get("Idempotence-Key"),
        paymentBody.metadata.citygo_order_id,
      );
      state.paymentBodies.push(structuredClone(paymentBody));
      return json(payment());
    }
    if (method === "GET" && path === `/v3/payments/${paymentId}`)
      return json(payment());
    if (method === "POST" && path === "/v3/refunds") {
      refundBody = JSON.parse(String(init?.body));
      const saved = (
        await db.query<{ create_payload: unknown }>(
          "select create_payload from payment_refunds where id=$1",
          [refundBody.metadata.citygo_refund_id],
        )
      ).rows[0];
      assert.ok(saved, "refund is durable before its monetary POST");
      assert.deepEqual(refundBody, saved.create_payload);
      assert.equal(refundBody.payment_id, paymentId);
      assert.equal(
        new Headers(init?.headers).get("Idempotence-Key"),
        refundBody.metadata.citygo_refund_id,
      );
      state.refundBodies.push(structuredClone(refundBody));
      state.refundedKopeks = Number(refundBody.amount.value.replace(".", ""));
      return json(refund());
    }
    if (method === "GET" && path === `/v3/refunds/${refundId}`)
      return json(refund());
    throw new Error("Unexpected synthetic payment request");
  };
  const config = readConfig({
    NODE_ENV: "test",
    WEB_ORIGIN: origin,
    LLM_PROVIDER: "disabled",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    YOOKASSA_MODE: "live",
    YOOKASSA_SHOP_ID: merchant,
    YOOKASSA_SECRET_KEY: "live_SYNTHETIC_NOT_A_REAL_KEY",
    YOOKASSA_RECEIPT_MODE: "npd_manual",
    YOOKASSA_FISCAL_PROFILE: "citygo_service_full_payment_v1",
  });
  const transport = {
    mode: "live" as const,
    shopId: merchant,
    secretKey: "live_SYNTHETIC_NOT_A_REAL_KEY",
    fetch,
  };
  const app = await buildApp({
    db,
    config,
    testing: true,
    paymentClient: new YooKassaClient(transport),
    refundClient: new YooKassaRefundClient(transport),
  });
  const call = (
    method: "GET" | "POST",
    path: string,
    token: string,
    body?: object,
  ) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: "citygo=" + token },
      ...(body ? { payload: body } : {}),
    });
  const register = async () => {
    const reply = await call("POST", "/v1/auth/register", "", {
      email: randomUUID() + "@example.test",
      password: "abcdef",
    });
    assert.equal(reply.statusCode, 200, reply.body);
    return { id: String(reply.json().user.id), token: reply.cookies[0]!.value };
  };
  const buyer = await register();
  const operator = await register();
  await db.query("update users set role='super_admin' where id=$1", [
    operator.id,
  ]);
  const admission = new PaymentAdmission(
    db,
    createPaymentAdmissionBinding(config)!,
  );
  const actor = {
    userId: operator.id,
    sessionTokenHash: tokenHash(operator.token),
  };
  await admission.command(actor, {
    requestId: randomUUID(),
    expectedRevision: 1,
    action: "set_reconciliation",
    enabled: true,
  });
  const run = await admission.beginReconciliation();
  assert.ok(run);
  await admission.completeReconciliation({ ...run, success: true });
  await admission.command(actor, {
    requestId: randomUUID(),
    expectedRevision: 2,
    action: "open",
    mode: "continuous",
    manualNpdResponsibilityAccepted: true,
  });
  return {
    db,
    state,
    buyer,
    operator,
    call,
    providerPaymentId: paymentId,
    providerRefundId: refundId,
    balance: async () =>
      (await call("GET", "/v1/ai/credit", buyer.token)).json<AiCredit>(),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

for (const amountKopeks of [2500, 10_000]) {
  test(`receipt journal integrates both real transports for ${amountKopeks === 10_000 ? "full" : "partial"} refund without POST settlement`, async (t) => {
    const f = await fixture();
    t.after(f.close);
    const created = await f.call("POST", "/v1/payments/topups", f.buyer.token, {
      requestId: randomUUID(),
      amountKopeks: 10_000,
      receiptEmail,
    });
    assert.equal(created.statusCode, 200, created.body);
    const orderId: string = created.json().orderId;
    assert.equal((await f.balance()).availableMicros, 0);
    assert.equal(
      (await f.db.query("select 1 from ai_credit_topups")).rows.length,
      0,
    );
    // Later account changes cannot rewrite the immutable buyer receipt contact.
    await f.db.query("update user_credentials set email=$2 where user_id=$1", [
      f.buyer.id,
      "later-account@synthetic-citygo-mail.ru",
    ]);
    f.state.paymentPaid = true;
    const paid = await f.call(
      "POST",
      `/v1/payments/topups/${orderId}/reconcile`,
      f.buyer.token,
      {},
    );
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal((await f.balance()).availableMicros, 100_000_000);
    const base = "/v1/admin/payments/refunds";
    const reserved = await f.call("POST", base, f.operator.token, {
      requestId: randomUUID(),
      paymentOperationId: orderId,
      amountKopeks,
    });
    assert.equal(reserved.statusCode, 200, reserved.body);
    const refundId: string = reserved.json().refund.id;
    const submitted = await f.call(
      "POST",
      `${base}/${refundId}/submit`,
      f.operator.token,
      {},
    );
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.equal(submitted.json().refund.status, "pending");
    assert.doesNotMatch(
      submitted.body,
      /receipt-buyer|later-account|receiptEmail/,
    );
    const repeatedSubmit = await f.call(
      "POST",
      `${base}/${refundId}/submit`,
      f.operator.token,
      {},
    );
    assert.equal(repeatedSubmit.statusCode, 200, repeatedSubmit.body);
    assert.equal((await f.balance()).heldMicros, amountKopeks * 10_000);
    assert.equal(
      (await f.db.query("select 1 from npd_refund_observations")).rows.length,
      0,
    );
    assert.equal(f.state.refundBodies.length, 1);
    const sent = f.state.refundBodies[0]!;
    if (amountKopeks === 10_000)
      assert.equal(Object.hasOwn(sent, "receipt"), false);
    else
      assert.deepEqual(sent.receipt, {
        ...f.state.paymentBodies[0]!.receipt,
        items: [
          {
            ...f.state.paymentBodies[0]!.receipt.items[0],
            amount: money(amountKopeks),
          },
        ],
      });
    for (let repeat = 0; repeat < 2; repeat++) {
      const settled = await f.call(
        "POST",
        `${base}/${refundId}/reconcile`,
        f.operator.token,
        {},
      );
      assert.equal(settled.statusCode, 200, settled.body);
      assert.equal(settled.json().refund.status, "succeeded");
    }
    const balance = await f.balance();
    assert.equal(balance.heldMicros, 0);
    assert.equal(balance.availableMicros, (10_000 - amountKopeks) * 10_000);
    assert.equal(f.state.refundBodies.length, 1);
    assert.deepEqual(
      (
        await f.db.query(
          "select buyer_email,cumulative_refunded_kopeks::integer as refunded,correction_status,registration_status from npd_receipt_tasks where id=$1",
          [orderId],
        )
      ).rows,
      [
        {
          buyer_email: receiptEmail,
          refunded: amountKopeks,
          correction_status: "required",
          registration_status: "pending",
        },
      ],
    );
    assert.equal(
      (await f.db.query("select 1 from npd_refund_observations")).rows.length,
      1,
    );
    assert.deepEqual(f.state.calls, [
      { method: "POST", path: "/v3/payments" },
      { method: "GET", path: `/v3/payments/${f.providerPaymentId}` },
      { method: "GET", path: `/v3/payments/${f.providerPaymentId}` },
      { method: "POST", path: "/v3/refunds" },
      { method: "GET", path: `/v3/refunds/${f.providerRefundId}` },
      { method: "GET", path: `/v3/payments/${f.providerPaymentId}` },
      { method: "GET", path: `/v3/refunds/${f.providerRefundId}` },
      { method: "GET", path: `/v3/payments/${f.providerPaymentId}` },
    ]);
  });
}

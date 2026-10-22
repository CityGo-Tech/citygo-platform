import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AiCreditLedger,
  PaymentRefunds,
  Repository,
  connectDatabase,
  migrate,
} from "@citygo/db";
import {
  YooKassaRefundClient,
  YooKassaRefundError,
} from "./yookassa-refunds.js";

test("live refund transport accepts the journal's immutable payload and only a separate GET settles money", async (t) => {
  // Entirely synthetic PGlite journal + injected fetch. No configured provider,
  // ambient key, external request, fiscal registration or real money is used.
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db);
  const operatorId = await repo.register(
    "refund-operator@example.test",
    "SYNTHETIC-NOT-A-PASSWORD-HASH",
  );
  const buyerId = await repo.register(
    "refund-buyer@example.test",
    "SYNTHETIC-NOT-A-PASSWORD-HASH",
  );
  await db.query("update users set role='super_admin' where id=$1", [
    operatorId,
  ]);
  const actor = { userId: operatorId, sessionTokenHash: "a".repeat(64) };
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
    [actor.sessionTokenHash, operatorId],
  );
  const shopId = "123456";
  const paymentOperationId = randomUUID();
  const providerPaymentId = randomUUID();
  const providerRefundId = randomUUID();
  const ledger = new AiCreditLedger(db);
  const refunds = new PaymentRefunds(db);
  await ledger.topUpConfirmed(buyerId, paymentOperationId, {
    providerPaymentId,
    paidKopeks: 10_000,
    merchantId: shopId,
    test: false,
    currency: "RUB",
    verification: "server_get_succeeded",
    verifiedAt: new Date().toISOString(),
  });
  const requestId = randomUUID();
  const reserved = await refunds.create(
    actor,
    { requestId, paymentOperationId, amountKopeks: 2500 },
    { merchantId: shopId, test: false },
  );
  const id = reserved.refund.id;
  assert.equal(
    (
      await refunds.create(
        actor,
        { requestId, paymentOperationId, amountKopeks: 2500 },
        { merchantId: shopId, test: false },
      )
    ).refund.id,
    id,
  );
  const prepared = await refunds.prepareDispatch(actor, id, {
    merchantId: shopId,
    test: false,
  });
  assert.ok(prepared.dispatch);
  const dispatched = prepared.dispatch;
  const expectedPayload = {
    payment_id: providerPaymentId,
    amount: { value: "25.00", currency: "RUB" },
    description: "Возврат средств CityGo",
    metadata: { citygo_refund_id: id },
  };
  assert.deepEqual(dispatched.input.createPayload, expectedPayload);
  const beforePayload = (
    await db.query<{ create_payload: unknown }>(
      "select create_payload from payment_refunds where id=$1",
      [id],
    )
  ).rows[0]!.create_payload;
  let refunded = "0.00";
  const calls: { url: string; method: string }[] = [];
  const client = new YooKassaRefundClient({
    mode: "live",
    shopId,
    secretKey: "live_SYNTHETIC_NOT_A_REAL_KEY",
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(url), method });
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      let body;
      if (method === "POST") {
        assert.equal(String(url), "https://api.yookassa.ru/v3/refunds");
        assert.equal(new Headers(init?.headers).get("Idempotence-Key"), id);
        assert.deepEqual(JSON.parse(String(init?.body)), expectedPayload);
        assert.equal((await ledger.status(buyerId)).heldMicros, 25_000_000);
        assert.equal(
          (
            await db.query<{ status: string }>(
              "select status from payment_refunds where id=$1",
              [id],
            )
          ).rows[0]!.status,
          "unknown",
        );
      }
      if (
        method === "POST" ||
        String(url) === "https://api.yookassa.ru/v3/refunds/" + providerRefundId
      ) {
        body = {
          id: providerRefundId,
          payment_id: providerPaymentId,
          amount: { value: "25.00", currency: "RUB" },
          status: "succeeded",
          metadata: { citygo_refund_id: id },
          created_at: new Date().toISOString(),
        };
      } else {
        assert.equal(
          String(url),
          "https://api.yookassa.ru/v3/payments/" + providerPaymentId,
        );
        assert.equal(method, "GET");
        body = {
          id: providerPaymentId,
          status: "succeeded",
          paid: true,
          test: false,
          refundable: true,
          amount: { value: "100.00", currency: "RUB" },
          refunded_amount: { value: refunded, currency: "RUB" },
          recipient: { account_id: shopId },
          metadata: { citygo_order_id: paymentOperationId },
        };
      }
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const created = await client.createRefund(dispatched.input);
  assert.equal(created.observation, "create_response");
  const pinned = await refunds.recordCreate(id, dispatched.token, created);
  assert.equal(pinned.refund.status, "pending");
  assert.equal((await ledger.status(buyerId)).heldMicros, 25_000_000);
  assert.equal(
    (await db.query("select id from npd_refund_observations")).rows.length,
    0,
  );
  // A completed create response cannot by itself debit/refund the account.
  await assert.rejects(refunds.recordObservation(id, created));
  refunded = "25.00";
  const observation = await client.getRefund(
    providerRefundId,
    dispatched.input,
  );
  const settled = await refunds.recordObservation(id, observation);
  assert.equal(settled.refund.status, "succeeded");
  assert.deepEqual(await refunds.recordObservation(id, observation), settled);
  const balance = await ledger.status(buyerId);
  assert.equal(balance.grantedMicros, 75_000_000);
  assert.equal(balance.availableMicros, 75_000_000);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.spentMicros, 0);
  assert.equal(
    (await db.query("select id from npd_refund_observations")).rows.length,
    1,
  );
  const receipt = (
    await db.query<{
      amount_kopeks: string;
      cumulative_refunded_kopeks: string;
      correction_status: string;
    }>(
      "select amount_kopeks::text,cumulative_refunded_kopeks::text,correction_status from npd_receipt_tasks where id=$1",
      [paymentOperationId],
    )
  ).rows[0]!;
  assert.equal(receipt.amount_kopeks, "10000");
  assert.equal(receipt.cumulative_refunded_kopeks, "2500");
  assert.equal(receipt.correction_status, "required");
  assert.deepEqual(
    (
      await db.query<{ create_payload: unknown }>(
        "select create_payload from payment_refunds where id=$1",
        [id],
      )
    ).rows[0]!.create_payload,
    beforePayload,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET", "GET"],
  );
  await assert.rejects(
    client.createRefund({
      ...dispatched.input,
      createPayload: { ...expectedPayload, description: "Возврат CityGo" },
    }),
    (error: unknown) =>
      error instanceof YooKassaRefundError &&
      error.code === "invalid_input" &&
      error.outcome === "not_sent",
  );
  assert.equal(calls.length, 4, "A changed stored body never reaches fetch");
});

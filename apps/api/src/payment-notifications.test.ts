import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  AiCreditLedger,
  DomainError,
  PaymentRefunds,
  PaymentTopupOrders,
  connectDatabase,
  migrate,
  type Database,
} from "@citygo/db";
import {
  PAYMENT_NOTIFICATION_PATH,
  PaymentNotificationInbox,
  registerPaymentNotifications,
  type PaymentNotification,
} from "./payment-notifications.js";
import type { YooKassaMode } from "./yookassa.js";

const shop = "123456";
function body(id: string, event = "payment.succeeded") {
  return { type: "notification", event, object: { id } };
}
async function fixture(t: TestContext, mode: YooKassaMode = "live") {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const userId = await registerSyntheticConsentingUser(
    db,
    "notification@example.test",
    "SYNTHETIC",
  );
  const orders = new PaymentTopupOrders(db);
  const order = await orders.create(
    userId,
    randomUUID(),
    10_000,
    shop,
    mode === "test",
    "https://citygo.example/",
  );
  const providerId = randomUUID();
  await orders.recordProvider(userId, order.id, {
    providerPaymentId: providerId,
    status: "pending",
  });
  let reconcile: (
    item: PaymentNotification,
  ) => Promise<"verified" | "retry"> = async () => "verified";
  const calls: PaymentNotification[] = [];
  const options = {
    mode,
    merchantId: shop,
    reconcile: async (item: PaymentNotification) => {
      calls.push(item);
      return reconcile(item);
    },
  };
  const inbox = new PaymentNotificationInbox(db, options);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof DomainError
        ? error.statusCode
        : typeof error === "object" &&
            error !== null &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    reply.code(status).send({
      error: "Notification unavailable",
    });
  });
  registerPaymentNotifications(app, inbox);
  t.after(async () => {
    await app.close();
    await db.close();
  });
  return {
    db,
    app,
    inbox,
    options,
    calls,
    userId,
    order,
    providerId,
    orders,
    setReconcile(callback: typeof reconcile) {
      reconcile = callback;
    },
    notify: (
      payload: unknown,
      headers: Record<string, string | undefined> = {},
    ) =>
      app.inject({
        method: "POST",
        url: PAYMENT_NOTIFICATION_PATH,
        headers: { "content-type": "application/json", ...headers },
        payload: JSON.stringify(payload),
      }),
  };
}

async function pendingRefund(f: Awaited<ReturnType<typeof fixture>>) {
  const ledger = new AiCreditLedger(f.db);
  await ledger.topUpConfirmed(f.userId, f.order.id, {
    providerPaymentId: f.providerId,
    paidKopeks: f.order.amountKopeks,
    merchantId: shop,
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  await f.db.query("update users set role='super_admin' where id=$1", [
    f.userId,
  ]);
  const token = "1".repeat(64);
  await f.db.query(
    "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
    [token, f.userId],
  );
  const refunds = new PaymentRefunds(f.db);
  const ctx = { userId: f.userId, sessionTokenHash: token };
  const created = await refunds.create(ctx, {
    requestId: randomUUID(),
    paymentOperationId: f.order.id,
    amountKopeks: 1000,
  });
  const prepared = await refunds.prepareDispatch(ctx, created.refund.id, {
    merchantId: shop,
    test: false,
  });
  assert.ok(prepared.dispatch);
  const providerRefundId = randomUUID();
  await refunds.recordCreate(created.refund.id, prepared.dispatch.token, {
    id: providerRefundId,
    refundRequestId: created.refund.id,
    paymentId: f.providerId,
    orderId: f.order.id,
    merchantId: shop,
    amountKopeks: 1000,
    currency: "RUB",
    test: false,
    refundedAmountKopeks: 0,
    status: "pending",
    observation: "create_response",
    verifiedAt: new Date().toISOString(),
  });
  return { refunds, ctx, refund: created.refund, providerRefundId };
}

async function anotherPending(
  f: Awaited<ReturnType<typeof fixture>>,
  merchantId = shop,
  providerId: string = randomUUID(),
) {
  const order = await f.orders.create(
    f.userId,
    randomUUID(),
    10_000,
    merchantId,
    f.options.mode === "test",
    "https://citygo.example/",
  );
  await f.orders.recordProvider(f.userId, order.id, {
    providerPaymentId: providerId,
    status: "pending",
  });
  return { ...order, providerId };
}

test("machine ingress durably queues only allowlisted bound IDs and discards incoming financial data", async (t) => {
  const f = await fixture(t);
  const malicious = {
    ...body(f.providerId),
    object: {
      id: f.providerId,
      status: "succeeded",
      paid: true,
      test: true,
      amount: { value: "999999.99", currency: "RUB" },
      customer: { email: "PRIVATE@example.test" },
      metadata: { PRIVATE: "PRIVATE", citygo_order_id: f.order.id },
    },
  };
  for (let index = 0; index < 3; index++)
    assert.equal((await f.notify(malicious)).statusCode, 200);
  const rows = (await f.db.query("select * from payment_notification_inbox"))
    .rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "pending");
  assert.doesNotMatch(
    JSON.stringify(rows),
    /PRIVATE|999999|customer|metadata|amount|paid/,
  );
  assert.equal(f.calls.length, 0); // enqueue never performs provider I/O
  assert.equal(
    (await f.db.query("select count(*)::integer as n from ai_credit_topups"))
      .rows[0]!.n,
    0,
  );
  assert.deepEqual(await f.inbox.processPending(1), {
    processed: 1,
    retained: 0,
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.objectId, f.providerId);
  assert.equal(f.calls[0]!.localId, f.order.id);
  assert.equal(f.calls[0]!.userId, f.userId);
  assert.equal(f.calls[0]!.test, false);
  assert.equal("amount" in f.calls[0]!, false);
  assert.equal("paid" in f.calls[0]!, false);
  assert.equal((await f.notify(malicious)).statusCode, 200);
  assert.deepEqual(await f.inbox.processPending(1), {
    processed: 0,
    retained: 0,
  });
  assert.equal(f.calls.length, 1);
});

test("unknown IDs, forged metadata hints and opposite shop/mode cannot grow the inbox", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++)
    assert.equal(
      (
        await f.notify({
          ...body(randomUUID()),
          object: {
            id: randomUUID(),
            metadata: { citygo_order_id: f.order.id },
          },
        })
      ).statusCode,
      200,
    );
  const sandbox = new PaymentNotificationInbox(f.db, {
    ...f.options,
    mode: "test",
  });
  assert.equal(await sandbox.enqueue(body(f.providerId)), "ignored");
  const anotherShop = new PaymentNotificationInbox(f.db, {
    ...f.options,
    merchantId: "999999",
  });
  assert.equal(await anotherShop.enqueue(body(f.providerId)), "ignored");
  assert.equal(
    (
      await f.db.query(
        "select count(*)::integer as n from payment_notification_inbox",
      )
    ).rows[0]!.n,
    0,
  );
});

test("malformed, oversized and browser-origin ingress is rejected without queuing", async (t) => {
  const f = await fixture(t);
  for (const payload of [
    {},
    { ...body(f.providerId), type: "payment" },
    body(f.providerId, "payment.refunded"),
    body("PRIVATE"),
    { ...body(f.providerId), object: null },
    { ...body(f.providerId), object: { id: [f.providerId] } },
  ])
    assert.equal((await f.notify(payload)).statusCode, 400);
  for (const headers of [
    { origin: "https://citygo.example" },
    { origin: "null" },
    { cookie: "session=PRIVATE" },
    { authorization: "Bearer PRIVATE" },
  ])
    assert.equal((await f.notify(body(f.providerId), headers)).statusCode, 403);
  assert.equal(
    (
      await f.notify({
        ...body(f.providerId),
        PRIVATE: "a".repeat(17 * 1024),
      })
    ).statusCode,
    413,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::integer as n from payment_notification_inbox",
      )
    ).rows[0]!.n,
    0,
  );
});

test("unknown verification failure retains a durable sanitized retry and later GET result can complete it", async (t) => {
  const f = await fixture(t);
  f.setReconcile(async () => {
    throw new Error("PRIVATE key and provider response body");
  });
  await f.inbox.enqueue(body(f.providerId));
  assert.deepEqual(await f.inbox.processPending(1), {
    processed: 0,
    retained: 1,
  });
  const pending = (await f.db.query("select * from payment_notification_inbox"))
    .rows[0]!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.last_reason, "verification_failed");
  assert.equal(pending.attempt_count, 1);
  assert.doesNotMatch(JSON.stringify(pending), /PRIVATE|key|response/);
  assert.deepEqual(await f.inbox.processPending(1), {
    processed: 0,
    retained: 0,
  }); // bounded due time, not a tight retry loop
  // Advance only this isolated queue's scheduling hint; identity stays intact.
  // Guard requires a processing claim for state transitions, so use an expired
  // claim with a short test-only SQL transport to simulate the passage of time.
  const expiredDb: Database = {
    ...f.db,
    query: (sql, params) =>
      f.db.query(
        sql.includes("with candidate as")
          ? sql.replace("next_attempt_at<=clock_timestamp()", "true")
          : sql,
        params,
      ),
  };
  f.setReconcile(async () => "verified");
  const restarted = new PaymentNotificationInbox(expiredDb, f.options);
  assert.deepEqual(await restarted.processPending(1), {
    processed: 1,
    retained: 0,
  });
  assert.equal(f.calls.length, 2);
});

test("a committed callback followed by process failure is replayed from an expired lease without duplicate financial effects", async (t) => {
  const f = await fixture(t);
  const ledger = new AiCreditLedger(f.db);
  let effects = 0;
  f.setReconcile(async (item) => {
    // This fixture represents only authenticated GET evidence. The callback
    // ignores the incoming notification amount/status and uses the local order.
    await ledger.topUpConfirmed(item.userId, item.localId, {
      providerPaymentId: item.objectId,
      paidKopeks: f.order.amountKopeks,
      merchantId: item.merchantId,
      test: item.test,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    effects++;
    return "verified";
  });
  let crash = true;
  const unstable: Database = {
    ...f.db,
    query: (sql, params) => {
      if (
        crash &&
        sql.startsWith("update payment_notification_inbox set status=")
      ) {
        crash = false;
        throw new Error("synthetic process loss after journal commit");
      }
      return f.db.query(
        sql.includes("with candidate as")
          ? sql.replace("interval '60 seconds'", "interval '-1 seconds'")
          : sql,
        params,
      );
    },
  };
  await f.inbox.enqueue(body(f.providerId));
  const first = new PaymentNotificationInbox(unstable, f.options);
  await assert.rejects(first.processPending(1));
  assert.equal(
    (await f.db.query("select status from payment_notification_inbox")).rows[0]!
      .status,
    "processing",
  );
  const restarted = new PaymentNotificationInbox(f.db, f.options);
  assert.deepEqual(await restarted.processPending(1), {
    processed: 1,
    retained: 0,
  });
  assert.equal(effects, 2); // GET/callback may replay; posting may not.
  assert.equal(
    (await f.db.query("select count(*)::integer as n from ai_credit_topups"))
      .rows[0]!.n,
    1,
  );
  assert.equal((await ledger.status(f.userId)).availableMicros, 100_000_000);
});

test("batch bounds, per-object events and completed identity are enforced in storage", async (t) => {
  const f = await fixture(t, "test");
  for (const event of [
    "payment.succeeded",
    "payment.canceled",
    "payment.waiting_for_capture",
  ])
    assert.equal(await f.inbox.enqueue(body(f.providerId, event)), "queued");
  await assert.rejects(f.inbox.processPending(0));
  await assert.rejects(f.inbox.processPending(26));
  await assert.rejects(f.inbox.processPending(1.5));
  assert.deepEqual(await f.inbox.processPending(2), {
    processed: 2,
    retained: 0,
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.test, true);
  await assert.rejects(
    f.db.query("update payment_notification_inbox set object_id=$1", [
      randomUUID(),
    ]),
  );
  await assert.rejects(
    f.db.query(
      "update payment_notification_inbox set status='pending' where status='processed'",
    ),
  );
  assert.deepEqual(await f.inbox.processPending(25), {
    processed: 1,
    retained: 0,
  });
});

test("concurrent drains do not claim a live lease and provider work holds no database transaction", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  const observed = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  f.setReconcile(async () => {
    started();
    await hold;
    return "verified";
  });
  await f.inbox.enqueue(body(f.providerId));
  const first = f.inbox.processPending(1);
  await observed;
  const second = new PaymentNotificationInbox(f.db, f.options);
  assert.deepEqual(await second.processPending(1), {
    processed: 0,
    retained: 0,
  });
  assert.equal(f.calls.length, 1);
  // Independent SQL remains usable while the provider callback is stalled.
  assert.equal((await f.db.query("select 1 as n")).rows[0]!.n, 1);
  release();
  assert.deepEqual(await first, { processed: 1, retained: 0 });
});

test("storage refuses unbound inbox rows and persistence failure is never acknowledged", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.db.query(
      `insert into payment_notification_inbox
       (id,event,object_id,payment_order_id,merchant_id,test)
       values($1,'payment.succeeded',$2,$3,$4,false)`,
      [randomUUID(), randomUUID(), f.order.id, shop],
    ),
  );
  const failingDb: Database = {
    ...f.db,
    query: (sql, params) => {
      if (sql.startsWith("insert into payment_notification_inbox"))
        return Promise.reject(new Error("PRIVATE persistence failure"));
      return f.db.query(sql, params);
    },
  };
  const app = Fastify();
  app.setErrorHandler((_error, _request, reply) => {
    reply.code(500).send({ error: "Notification unavailable" });
  });
  registerPaymentNotifications(
    app,
    new PaymentNotificationInbox(failingDb, f.options),
  );
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: PAYMENT_NOTIFICATION_PATH,
    payload: body(f.providerId),
  });
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /PRIVATE/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::integer as n from payment_notification_inbox",
      )
    ).rows[0]!.n,
    0,
  );
});

test("bound refund notifications keep refund identity and never trust nonexistent refund mode fields", async (t) => {
  const f = await fixture(t);
  const { refund, providerRefundId } = await pendingRefund(f);
  assert.equal(
    await f.inbox.enqueue(body(providerRefundId, "refund.succeeded")),
    "queued",
  );
  assert.deepEqual(await f.inbox.processPending(1), {
    processed: 1,
    retained: 0,
  });
  assert.equal(f.calls[0]!.kind, "refund");
  assert.equal(f.calls[0]!.localId, refund.id);
  assert.equal(f.calls[0]!.objectId, providerRefundId);
  assert.equal(f.calls[0]!.test, false);
  assert.equal(
    (
      await f.db.query("select status from payment_refunds where id=$1", [
        refund.id,
      ])
    ).rows[0]!.status,
    "pending",
  );
});

test("known-ID fallback scans payment and refund together in bounded oldest-first batches", async (t) => {
  const f = await fixture(t);
  const { refund, providerRefundId } = await pendingRefund(f);
  const later = await anotherPending(f);
  await f.db.query(
    "update payment_topup_orders set updated_at=clock_timestamp()+interval '2 minutes' where id=$1",
    [f.order.id],
  );
  await f.db.query(
    "update payment_topup_orders set updated_at=clock_timestamp()+interval '3 minutes' where id=$1",
    [later.id],
  );
  assert.equal(await f.inbox.enqueueKnownPending(1), 1);
  let rows = (await f.db.query("select * from payment_notification_inbox"))
    .rows;
  assert.equal(rows[0]!.object_id, providerRefundId);
  assert.equal(rows[0]!.refund_id, refund.id);
  assert.equal(rows[0]!.event, "refund.succeeded");
  assert.equal(f.calls.length, 0);
  assert.equal(await f.inbox.enqueueKnownPending(1), 1);
  assert.equal(await f.inbox.enqueueKnownPending(1), 1);
  assert.equal(await f.inbox.enqueueKnownPending(25), 0);
  assert.equal(f.calls.length, 0); // No GET, POST, or money proof in the scan.
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), false);
  rows = (await f.db.query("select * from payment_notification_inbox")).rows;
  assert.deepEqual(
    rows.map((row) => row.object_id).sort(),
    [providerRefundId, f.providerId, later.providerId].sort(),
  );
  assert.deepEqual(await f.inbox.processPending(3), {
    processed: 3,
    retained: 0,
  });
  const completed = (
    await f.db.query("select * from payment_notification_inbox order by id")
  ).rows;
  assert.equal(await f.inbox.enqueueKnownPending(25), 0);
  assert.deepEqual(
    (await f.db.query("select * from payment_notification_inbox order by id"))
      .rows,
    completed,
  ); // Even still-pending local objects cannot rewrite processed hints.
});

test("known-ID fallback and failure health are isolated by exact merchant and test mode", async (t) => {
  const f = await fixture(t);
  const foreign = await anotherPending(f, "999999");
  await f.orders.markReviewRequired(f.userId, foreign.id);
  const foreignInbox = new PaymentNotificationInbox(f.db, {
    ...f.options,
    merchantId: "999999",
  });
  const testInbox = new PaymentNotificationInbox(f.db, {
    ...f.options,
    mode: "test",
  });
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), false);
  assert.equal(await foreignInbox.hasUnresolvedVerificationFailures(), true);
  assert.equal(await testInbox.hasUnresolvedVerificationFailures(), false);
  assert.equal(await testInbox.enqueueKnownPending(25), 0);
  assert.equal(await foreignInbox.enqueueKnownPending(25), 0);
  assert.equal(await f.inbox.enqueueKnownPending(25), 1);
  assert.equal(
    (await f.db.query("select * from payment_notification_inbox")).rows[0]!
      .object_id,
    f.providerId,
  );
  await f.orders.markReviewRequired(f.userId, f.order.id);
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), true);
  assert.equal(await testInbox.hasUnresolvedVerificationFailures(), false);
});

test("test-mode fallback excludes queued unbound, terminal and review-required orders", async (t) => {
  const f = await fixture(t, "test");
  await f.orders.recordProvider(f.userId, f.order.id, {
    providerPaymentId: f.providerId,
    status: "canceled",
  });
  await f.orders.create(
    f.userId,
    randomUUID(),
    10_000,
    shop,
    true,
    "https://citygo.example/",
  );
  const review = await anotherPending(f);
  await f.orders.markReviewRequired(f.userId, review.id);
  const pending = await anotherPending(f);
  assert.equal(await f.inbox.enqueueKnownPending(25), 1);
  const rows = (await f.db.query("select * from payment_notification_inbox"))
    .rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.object_id, pending.providerId);
  assert.equal(rows[0]!.test, true);
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), true);
  const liveInbox = new PaymentNotificationInbox(f.db, {
    ...f.options,
    mode: "live",
  });
  assert.equal(await liveInbox.enqueueKnownPending(25), 0);
  assert.equal(await liveInbox.hasUnresolvedVerificationFailures(), false);
});

test("legacy malformed and noncanonical IDs are skipped before LIMIT and require review without rewriting history", async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const legacy = await anotherPending(f, shop, `legacy_provider_${index}`);
    ids.push(legacy.id);
  }
  const uppercase = await anotherPending(f, shop, randomUUID().toUpperCase());
  ids.push(uppercase.id);
  await f.db.query(
    "update payment_topup_orders set updated_at=clock_timestamp()+interval '1 minute' where id=$1",
    [f.order.id],
  );
  const before = (
    await f.db.query(
      "select * from payment_topup_orders where id=any($1::uuid[]) order by id",
      [ids],
    )
  ).rows;
  assert.equal(await f.inbox.enqueueKnownPending(1), 1);
  assert.equal(await f.inbox.enqueueKnownPending(1), 0);
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), true);
  assert.deepEqual(
    (
      await f.db.query(
        "select * from payment_topup_orders where id=any($1::uuid[]) order by id",
        [ids],
      )
    ).rows,
    before,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await f.db.query("select * from payment_notification_inbox")).rows[0]!
      .object_id,
    f.providerId,
  );
});

test("fallback wake hint needs a later authenticated GET callback before posting and settles a missing webhook exactly once", async (t) => {
  const f = await fixture(t);
  const ledger = new AiCreditLedger(f.db);
  let authenticatedGets = 0;
  f.setReconcile(async (item) => {
    authenticatedGets++;
    // Fake authenticated GET evidence, never an incoming event/status proof.
    await ledger.topUpConfirmed(item.userId, item.localId, {
      providerPaymentId: item.objectId,
      paidKopeks: f.order.amountKopeks,
      merchantId: item.merchantId,
      test: item.test,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    await f.orders.recordProvider(item.userId, item.localId, {
      providerPaymentId: item.objectId,
      status: "succeeded",
    });
    return "verified";
  });
  assert.equal(await f.inbox.enqueueKnownPending(10), 1);
  assert.equal(authenticatedGets, 0);
  assert.equal((await ledger.status(f.userId)).availableMicros, 0);
  assert.deepEqual(await f.inbox.processPending(10), {
    processed: 1,
    retained: 0,
  });
  assert.equal(authenticatedGets, 1);
  assert.equal((await ledger.status(f.userId)).availableMicros, 100_000_000);
  assert.equal(await f.inbox.enqueueKnownPending(10), 0);
  assert.equal(await f.inbox.enqueue(body(f.providerId)), "duplicate");
  assert.deepEqual(await f.inbox.processPending(10), {
    processed: 0,
    retained: 0,
  });
  assert.equal(authenticatedGets, 1);
  assert.equal(
    (await f.db.query("select count(*)::integer as n from ai_credit_topups"))
      .rows[0]!.n,
    1,
  );
});

test("normal pending retry is healthy but failed authenticated verification stays unhealthy until resolved", async (t) => {
  const f = await fixture(t);
  f.setReconcile(async () => "retry");
  assert.equal(await f.inbox.enqueueKnownPending(), 1);
  assert.deepEqual(await f.inbox.processPending(1), {
    processed: 0,
    retained: 1,
  });
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), false);
  assert.equal(
    (await f.db.query("select last_reason from payment_notification_inbox"))
      .rows[0]!.last_reason,
    "retry_required",
  );
  const dueDb: Database = {
    ...f.db,
    query: (sql, params) =>
      f.db.query(
        sql.includes("with candidate as")
          ? sql.replace("next_attempt_at<=clock_timestamp()", "true")
          : sql,
        params,
      ),
  };
  const restarted = new PaymentNotificationInbox(dueDb, f.options);
  f.setReconcile(async () => {
    throw new Error("PRIVATE fake GET verification failure");
  });
  assert.deepEqual(await restarted.processPending(1), {
    processed: 0,
    retained: 1,
  });
  assert.equal(await restarted.hasUnresolvedVerificationFailures(), true);
  const oppositeMode = new PaymentNotificationInbox(f.db, {
    ...f.options,
    mode: "test",
  });
  assert.equal(await oppositeMode.hasUnresolvedVerificationFailures(), false);
  const foreignShop = new PaymentNotificationInbox(f.db, {
    ...f.options,
    merchantId: "999999",
  });
  assert.equal(await foreignShop.hasUnresolvedVerificationFailures(), false);
  assert.doesNotMatch(
    JSON.stringify(
      (await f.db.query("select * from payment_notification_inbox")).rows,
    ),
    /PRIVATE|fake GET/,
  );
  f.setReconcile(async () => "verified");
  assert.deepEqual(await restarted.processPending(1), {
    processed: 1,
    retained: 0,
  });
  assert.equal(await restarted.hasUnresolvedVerificationFailures(), false);
});

test("refund review reasons block health without confusing normal provider pending with failure", async (t) => {
  const f = await fixture(t);
  const { refund, refunds } = await pendingRefund(f);
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), false);
  await refunds.recordReconcileFailure(refund.id, "provider_transport_failure");
  assert.equal(await f.inbox.hasUnresolvedVerificationFailures(), true);
  const foreignShop = new PaymentNotificationInbox(f.db, {
    ...f.options,
    merchantId: "999999",
  });
  assert.equal(await foreignShop.hasUnresolvedVerificationFailures(), false);
});

test("known-ID fallback validates batch bounds before querying storage", async () => {
  let queries = 0;
  const db = {
    query: async () => {
      queries++;
      throw new Error("must not query");
    },
  } as unknown as Database;
  const inbox = new PaymentNotificationInbox(db, {
    mode: "live",
    merchantId: shop,
    reconcile: async () => "verified",
  });
  for (const invalid of [0, 26, 1.5, NaN, Infinity])
    await assert.rejects(inbox.enqueueKnownPending(invalid), DomainError);
  assert.equal(queries, 0);
});

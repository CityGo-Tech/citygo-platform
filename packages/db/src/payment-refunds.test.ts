import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  AiCreditLedger,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type Database,
} from "./index.js";
import {
  PaymentRefunds,
  type PaymentRefundContext,
  type PaymentRefundObservation,
} from "./payment-refunds.js";

const error = (status: number) => (value: unknown) =>
  value instanceof DomainError && value.statusCode === status;
async function fixture(t: TestContext, sandbox = false) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    ids: string[] = [];
  for (const name of ["operator", "buyer", "other"])
    ids.push(await repo.register(`${name}@example.test`, "SYNTHETIC-NOT-HASH"));
  const [adminId, buyerId, otherId] = ids as [string, string, string];
  await db.query("update users set role='super_admin' where id=$1", [adminId]);
  const contexts: PaymentRefundContext[] = [];
  for (let i = 0; i < ids.length; i++) {
    const sessionTokenHash = String(i + 1).repeat(64),
      userId = ids[i]!;
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [sessionTokenHash, userId],
    );
    contexts.push({ userId, sessionTokenHash });
  }
  const [admin, buyer, other] = contexts as [
    PaymentRefundContext,
    PaymentRefundContext,
    PaymentRefundContext,
  ];
  const ledger = new AiCreditLedger(db),
    store = new PaymentRefunds(db);
  const paymentOperationId = randomUUID(),
    providerPaymentId = randomUUID();
  await ledger.topUpConfirmed(buyerId, paymentOperationId, {
    providerPaymentId,
    paidKopeks: 10_000,
    merchantId: "123456",
    test: sandbox,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const create = (amountKopeks = 2500, requestId = randomUUID()) =>
    store.create(admin, { requestId, paymentOperationId, amountKopeks });
  const proof = (
    id: string,
    overrides: Partial<PaymentRefundObservation> = {},
  ): PaymentRefundObservation => ({
    id: randomUUID(),
    refundRequestId: id,
    paymentId: providerPaymentId,
    orderId: paymentOperationId,
    merchantId: "123456",
    amountKopeks: 2500,
    currency: "RUB",
    test: sandbox,
    refundedAmountKopeks: 2500,
    status: "succeeded",
    observation: "server_get",
    verifiedAt: new Date().toISOString(),
    ...overrides,
  });
  return {
    db,
    ledger,
    store,
    admin,
    buyer,
    other,
    adminId,
    buyerId,
    otherId,
    paymentOperationId,
    providerPaymentId,
    create,
    proof,
  };
}

test("refund reserve pins paid source, replay, FIFO availability and cannot cash out a gift", async (t) => {
  const f = await fixture(t);
  await f.ledger.grantWelcome(f.buyerId, f.adminId);
  const request = randomUUID(),
    result = await f.create(2500, request);
  assert.equal(result.refund.status, "reserved");
  assert.deepEqual(await f.create(2500, request), result);
  await assert.rejects(f.create(2501, request), error(409));
  await assert.rejects(
    f.store.create(f.admin, {
      requestId: request,
      paymentOperationId: randomUUID(),
      amountKopeks: 2500,
    }),
    error(409),
  );
  await assert.rejects(f.create(100), error(409)); // one open refund/source
  await assert.rejects(
    f.store.create(f.buyer, {
      requestId: randomUUID(),
      paymentOperationId: f.paymentOperationId,
      amountKopeks: 100,
    }),
    error(403),
  );
  const credit = await f.ledger.status(f.buyerId);
  assert.equal(credit.grantedMicros, 600_000_000);
  assert.equal(credit.heldMicros, 25_000_000);
  assert.equal(credit.availableMicros, 575_000_000);
  const sources = await f.store.sources(f.admin, f.buyerId);
  assert.equal(sources.sources.length, 1);
  assert.equal(sources.sources[0]!.availableMicros, 75_000_000);
  assert.equal(sources.sources[0]!.refundReservedMicros, 25_000_000);
  const holdId = randomUUID();
  await f.ledger.hold(f.buyerId, holdId, 550_000_000);
  const held = (await f.store.sources(f.admin, f.buyerId)).sources[0]!;
  assert.equal(held.heldMicros, 50_000_000); // all 500 gift RUB first
  assert.equal(held.availableMicros, 25_000_000);
  await assert.rejects(
    f.ledger.hold(f.buyerId, randomUUID(), 25_000_001),
    /Недостаточно доступного баланса/,
  );
});

test("separate GET posts money exactly once and atomically creates the NPD correction obligation", async (t) => {
  const f = await fixture(t);
  const created = await f.create(),
    id = created.refund.id;
  const prepared = await f.store.prepareDispatch(f.admin, id, {
    merchantId: "123456",
    test: false,
  });
  assert.ok(prepared.dispatch);
  assert.equal(prepared.detail.refund.status, "unknown");
  const proof = f.proof(id);
  const posted = await f.store.recordCreate(id, prepared.dispatch.token, {
    ...proof,
    observation: "create_response",
    refundedAmountKopeks: 0,
  });
  assert.equal(posted.refund.status, "pending");
  assert.equal((await f.ledger.status(f.buyerId)).heldMicros, 25_000_000);
  assert.equal(
    (await f.db.query("select * from npd_refund_observations")).rows.length,
    0,
  );
  const settled = await f.store.recordObservation(id, proof);
  assert.equal(settled.refund.status, "succeeded");
  assert.deepEqual(await f.store.recordObservation(id, proof), settled);
  const status = await f.ledger.status(f.buyerId);
  assert.equal(status.grantedMicros, 75_000_000);
  assert.equal(status.heldMicros, 0);
  assert.equal(status.spentMicros, 0);
  assert.equal(status.availableMicros, 75_000_000);
  const task = (
    await f.db.query<{
      correction_status: string;
      cumulative_refunded_kopeks: string;
    }>(
      "select correction_status,cumulative_refunded_kopeks::text from npd_receipt_tasks where payment_id=$1",
      [f.providerPaymentId],
    )
  ).rows[0]!;
  assert.equal(task.correction_status, "required");
  assert.equal(task.cumulative_refunded_kopeks, "2500");
  assert.equal(
    (await f.db.query("select * from npd_refund_observations")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select * from ai_credit_topups")).rows.length,
    1,
  );
  const second = await f.create(1000);
  const dispatch = await f.store.prepareReconcile(
    f.admin,
    second.refund.id,
    { merchantId: "123456", test: false },
    randomUUID(),
  );
  assert.equal(dispatch.input.refundedBeforeKopeks, 2500);
});

test("a canceled POST does not release funds; only separately verified cancellation does", async (t) => {
  const f = await fixture(t, true),
    { refund } = await f.create();
  const prepared = await f.store.prepareDispatch(f.admin, refund.id, {
    merchantId: "123456",
    test: true,
  });
  const proof = f.proof(refund.id, {
    status: "canceled",
    refundedAmountKopeks: 0,
  });
  await f.store.recordCreate(refund.id, prepared.dispatch!.token, {
    ...proof,
    observation: "create_response",
  });
  assert.equal((await f.ledger.status(f.buyerId)).heldMicros, 25_000_000);
  const result = await f.store.recordObservation(refund.id, proof);
  assert.equal(result.refund.status, "canceled");
  assert.deepEqual(await f.store.recordObservation(refund.id, proof), result);
  assert.equal((await f.ledger.status(f.buyerId)).availableMicros, 100_000_000);
  assert.equal(
    (await f.db.query("select * from npd_receipt_tasks")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select * from npd_refund_observations")).rows.length,
    0,
  );
  assert.equal((await f.create()).refund.status, "reserved");
});

test("unknown transport persists its reserve, stable payload and guarded dispatch lease", async (t) => {
  const f = await fixture(t),
    { refund } = await f.create();
  const config = { merchantId: "123456", test: false };
  const first = await f.store.prepareDispatch(f.admin, refund.id, config);
  await assert.rejects(
    f.store.prepareDispatch(f.admin, refund.id, config),
    error(409),
  );
  const failed = await f.store.recordDispatchFailure(
    refund.id,
    first.dispatch!.token,
    "provider_transport_failure",
  );
  assert.equal(failed.refund.status, "unknown");
  const second = await f.store.prepareDispatch(f.admin, refund.id, config);
  assert.deepEqual(second.dispatch!.input, first.dispatch!.input);
  assert.notEqual(second.dispatch!.token, first.dispatch!.token);
  const late = await f.store.recordDispatchFailure(
    refund.id,
    first.dispatch!.token,
    "provider_transport_failure",
  );
  assert.equal(late.refund.attemptCount, 2);
  assert.equal(late.refund.reviewReason, "dispatch_result_unknown");
  assert.equal((await f.ledger.status(f.buyerId)).heldMicros, 25_000_000);
  await assert.rejects(
    f.store.prepareReconcile(f.admin, refund.id, config),
    error(409),
  );
  const verified = f.proof(refund.id);
  const candidate = await f.store.prepareReconcile(
    f.admin,
    refund.id,
    config,
    verified.id,
  );
  assert.equal(candidate.refundId, verified.id);
  assert.equal(
    (await f.store.recordObservation(refund.id, verified)).refund.status,
    "succeeded",
  );
});

test("mismatched evidence and out-of-band cumulative refunds retain reserve and block new monetary admission", async (t) => {
  for (const patch of [
    { paymentId: randomUUID() },
    { refundedAmountKopeks: 2501 },
  ]) {
    const f = await fixture(t),
      { refund } = await f.create();
    const result = await f.store.recordObservation(
      refund.id,
      f.proof(refund.id, patch),
    );
    assert.equal(result.refund.status, "review_required");
    assert.equal((await f.ledger.status(f.buyerId)).heldMicros, 25_000_000);
    await assert.rejects(f.ledger.hold(f.buyerId, randomUUID(), 1), error(409));
    await assert.rejects(f.create(), error(409));
    assert.equal(
      (await f.db.query("select * from npd_refund_observations")).rows.length,
      0,
    );
  }
});

test("authorization is checked on replay and history; owner projections exclude merchant/attempt/actor evidence", async (t) => {
  const f = await fixture(t),
    created = await f.create();
  const owner = await f.store.listOwner(f.buyer),
    other = await f.store.listOwner(f.other);
  assert.equal(owner.refunds.length, 1);
  assert.equal(other.refunds.length, 0);
  for (const hidden of [
    "merchantId",
    "providerPaymentId",
    "providerRefundId",
    "requestId",
    "attemptCount",
    "reviewReason",
    "events",
    "userId",
  ])
    assert.ok(!(hidden in owner.refunds[0]!));
  const sources = await f.store.sources(f.buyer);
  for (const hidden of ["merchantId", "providerPaymentId", "id", "userId"])
    assert.ok(!(hidden in sources.sources[0]!));
  await f.db.query("update users set role='user' where id=$1", [f.adminId]);
  await assert.rejects(
    f.store.detailAdmin(f.admin, created.refund.id),
    error(403),
  );
  await assert.rejects(
    f.store.create(f.admin, {
      requestId: created.refund.requestId,
      paymentOperationId: f.paymentOperationId,
      amountKopeks: 2500,
    }),
    error(403),
  );
  await f.db.query("delete from sessions where token_hash=$1", [
    f.buyer.sessionTokenHash,
  ]);
  await assert.rejects(f.store.listOwner(f.buyer), error(401));
});

test("refund identity and monetary events are immutable even with SQL writes", async (t) => {
  const f = await fixture(t),
    { refund } = await f.create();
  await assert.rejects(
    f.db.query(
      'update payment_refunds set create_payload=create_payload || \'{"description":"changed"}\'::jsonb,revision=revision+1 where id=$1',
      [refund.id],
    ),
  );
  await assert.rejects(
    f.db.query(
      "update payment_refunds set amount_kopeks=2600,revision=revision+1 where id=$1",
      [refund.id],
    ),
  );
  await assert.rejects(
    f.db.query(
      "update payment_refund_events set payload='{}'::jsonb where refund_id=$1",
      [refund.id],
    ),
  );
  await assert.rejects(
    f.db.query("delete from payment_refund_events where refund_id=$1", [
      refund.id,
    ]),
  );
  const forged = randomUUID();
  await assert.rejects(
    f.db.query(
      `insert into payment_refunds(id,request_id,created_by_user_id,user_id,payment_operation_id,provider_payment_id,merchant_id,test,amount_kopeks,payment_amount_kopeks,refunded_before_kopeks,create_key,create_payload)
    values($1,$2,$3,$4,$5,$6,'123456',false,100,10000,0,$1,$7)`,
      [
        forged,
        randomUUID(),
        f.adminId,
        f.buyerId,
        f.paymentOperationId,
        f.providerPaymentId,
        JSON.stringify({
          payment_id: f.providerPaymentId,
          amount: { value: "1.00", currency: "RUB" },
          description: "Возврат средств CityGo",
          metadata: { citygo_refund_id: forged },
        }),
      ],
    ),
    (failure: unknown) =>
      typeof failure === "object" &&
      failure !== null &&
      "code" in failure &&
      failure.code === "23514",
  );
});

test("receipt failure rolls back refund posting, source resolution and journal together", async (t) => {
  const f = await fixture(t),
    { refund } = await f.create();
  const failing: Database = {
    ...f.db,
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          ...tx,
          query: async <T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) => {
            if (sql.startsWith("insert into npd_refund_observations"))
              throw new Error("synthetic receipt write failure");
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new PaymentRefunds(failing).recordObservation(
      refund.id,
      f.proof(refund.id),
    ),
    /synthetic receipt/,
  );
  const status = await f.ledger.status(f.buyerId);
  assert.equal(status.grantedMicros, 100_000_000);
  assert.equal(status.heldMicros, 25_000_000);
  assert.equal(
    (await f.store.detailAdmin(f.admin, refund.id)).refund.status,
    "reserved",
  );
  assert.equal(
    (await f.store.sources(f.admin, f.buyerId)).sources[0]!.refundedMicros,
    0,
  );
  assert.equal(
    (await f.db.query("select * from npd_refund_observations")).rows.length,
    0,
  );
});

test("out-of-order GET snapshots cannot regress settled money or falsely freeze later known refunds", async (t) => {
  const f = await fixture(t),
    first = (await f.create()).refund,
    p1 = f.proof(first.id);
  const settled = await f.store.recordObservation(first.id, p1);
  assert.deepEqual(
    await f.store.recordObservation(first.id, {
      ...p1,
      status: "pending",
      refundedAmountKopeks: 0,
    }),
    settled,
  );
  const second = (await f.create(1000)).refund,
    p2 = f.proof(second.id, { amountKopeks: 1000, refundedAmountKopeks: 3500 });
  // Inconsistent GET refund(pending) + GET payment(already refunded) remains a
  // reserved pending request until a fresh GET confirms its terminal state.
  assert.equal(
    (await f.store.recordObservation(second.id, { ...p2, status: "pending" }))
      .refund.status,
    "pending",
  );
  assert.equal((await f.ledger.status(f.buyerId)).heldMicros, 10_000_000);
  await f.store.recordObservation(second.id, p2);
  assert.deepEqual(await f.store.recordObservation(first.id, p1), settled);
  const current = await f.store.recordObservation(first.id, {
    ...p1,
    refundedAmountKopeks: 3500,
  });
  assert.equal(current.refund.reviewReason, null);
  assert.equal(
    (
      await f.db.query<{ billing_review_required: boolean }>(
        "select billing_review_required from ai_credit_accounts where user_id=$1",
        [f.buyerId],
      )
    ).rows[0]!.billing_review_required,
    false,
  );
  const drift = await f.store.recordObservation(first.id, {
    ...p1,
    refundedAmountKopeks: 3501,
  });
  assert.equal(drift.refund.status, "succeeded");
  assert.equal(drift.refund.reviewReason, "external_refund_drift");
  await assert.rejects(f.ledger.hold(f.buyerId, randomUUID(), 1), error(409));
});

test("contradictory stored monetary events fail closed as a server error", async (t) => {
  const f = await fixture(t),
    { refund } = await f.create();
  await f.db.query(
    "insert into payment_refund_events(refund_id,action,actor_user_id,revision,payload) values($1,'provider_observed',null,2,'{\"reason\":\"provider_transport_failure\"}'::jsonb)",
    [refund.id],
  );
  await assert.rejects(
    f.store.detailAdmin(f.admin, refund.id),
    (failure: unknown) =>
      failure instanceof Error &&
      !(failure instanceof DomainError) &&
      /Stored refund data/.test(failure.message),
  );
  assert.equal((await f.ledger.status(f.buyerId)).heldMicros, 25_000_000);
});

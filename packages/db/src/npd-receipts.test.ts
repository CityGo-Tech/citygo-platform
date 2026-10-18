import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  AiCreditLedger,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type Database,
} from "./index.js";
import { NpdReceipts, type NpdReceiptContext } from "./npd-receipts.js";
const url = (id: string) =>
  `https://lknpd.nalog.ru/api/v1/receipt/SYNTHETIC_${id}/print`;
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
async function seed(db: Database) {
  const repo = new Repository(db);
  const admin = await repo.register(
    "operator@example.test",
    "synthetic-not-password",
  );
  const second = await repo.register(
    "second-operator@example.test",
    "synthetic-not-password",
  );
  const buyer = await repo.register(
    "buyer@example.test",
    "synthetic-not-password",
  );
  const other = await repo.register(
    "other@example.test",
    "synthetic-not-password",
  );
  await db.query(
    "update users set role=case when id=$1 then 'super_admin' else 'admin' end where id=$1 or id=$2",
    [admin, second],
  );
  const contexts: NpdReceiptContext[] = [];
  for (const [userId, character] of [
    [admin, "a"],
    [second, "b"],
    [buyer, "c"],
    [other, "d"],
  ] as const) {
    const sessionTokenHash = character.repeat(64);
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [sessionTokenHash, userId],
    );
    contexts.push({ userId, sessionTokenHash });
  }
  const store = new NpdReceipts(db),
    ledger = new AiCreditLedger(db);
  const addPayment = async (test = false, userId = buyer) => {
    const id = randomUUID(),
      paymentId = randomUUID();
    const proof = {
      providerPaymentId: paymentId,
      paidKopeks: 10000,
      merchantId: "synthetic-shop",
      test,
      verifiedAt: "2026-10-18T00:00:00.000Z",
      verification: "server_get_succeeded" as const,
      currency: "RUB" as const,
    };
    await ledger.topUpConfirmed(userId, id, proof);
    return { id, paymentId, proof };
  };
  return {
    db,
    store,
    ledger,
    addPayment,
    admin: contexts[0]!,
    second: contexts[1]!,
    buyer: contexts[2]!,
    other: contexts[3]!,
  };
}
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return seed(db);
}
async function claimed(f: Awaited<ReturnType<typeof seed>>, id: string) {
  return f.store.command(f.admin, id, {
    action: "claim",
    requestId: randomUUID(),
    expectedRevision: 1,
  });
}
async function registered(f: Awaited<ReturnType<typeof seed>>, id: string) {
  const claim = await claimed(f, id);
  const receiptId = randomUUID();
  const input = {
    action: "register" as const,
    requestId: randomUUID(),
    expectedRevision: claim.task.revision,
    receiptId,
    receiptUrl: url(receiptId),
    amountKopeks: 10000,
    operatorReported: true as const,
  };
  const result = await f.store.command(f.admin, id, input);
  return { ...result, input };
}
const observation = (
  paymentId: string,
  userId: string,
  amountKopeks: number,
  providerRefundId = randomUUID(),
) => ({
  userId,
  providerPaymentId: paymentId,
  providerRefundId,
  merchantId: "synthetic-shop",
  amountKopeks,
  currency: "RUB" as const,
  test: false as const,
  status: "succeeded" as const,
  verification: "server_get_succeeded" as const,
  observedAt: "2026-10-18T00:00:00.000Z",
});

test("new live postings atomically create one gross obligation, sandbox postings create none", async (t) => {
  const f = await fixture(t);
  const p = await f.addPayment();
  await f.ledger.topUpConfirmed(f.buyer.userId, randomUUID(), p.proof);
  const detail = await f.store.detailAdmin(f.admin, p.id);
  assert.equal(detail.task.amountKopeks, 10000);
  assert.equal(detail.task.buyerEmail, "buyer@example.test");
  assert.equal(detail.task.registrationStatus, "pending");
  assert.equal(detail.task.deliveryStatus, "pending");
  assert.equal(detail.events.length, 0);
  assert.equal((await f.store.listAdmin(f.admin)).tasks.length, 1);
  const separate = await connectDatabase("pglite://:memory:");
  t.after(() => separate.close());
  await migrate(separate);
  const sandbox = await seed(separate);
  await sandbox.addPayment(true);
  assert.equal((await sandbox.store.listAdmin(sandbox.admin)).tasks.length, 0);
});
test("an obligation failure rolls back its payment posting and balance in the same transaction", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    "create function synthetic_fail_npd() returns trigger language plpgsql as $$ begin raise exception 'synthetic'; end $$; create trigger synthetic_fail_npd before insert on npd_receipt_tasks for each row execute function synthetic_fail_npd()",
  );
  await assert.rejects(f.addPayment());
  assert.equal(
    (await f.db.query("select * from ai_credit_topups")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select * from ai_credit_entries")).rows.length,
    0,
  );
});
test("registration, delivery and review are independent reports; retries never duplicate evidence or money", async (t) => {
  const f = await fixture(t);
  const p = await f.addPayment();
  const before = await f.ledger.status(f.buyer.userId);
  const register = await registered(f, p.id);
  assert.equal(register.task.deliveryStatus, "pending");
  const delivery = {
    action: "delivery",
    requestId: randomUUID(),
    expectedRevision: register.task.revision,
    receiptEvidenceId: register.task.activeEvidenceId,
    channel: "email",
    operatorReported: true,
  };
  const sent = await f.store.command(f.admin, p.id, delivery);
  assert.equal(sent.task.deliveryStatus, "operator_reported");
  const replay = await f.store.command(f.admin, p.id, register.input);
  assert.equal(replay.task.revision, sent.task.revision);
  assert.equal(
    (await f.db.query("select * from npd_receipt_evidence")).rows.length,
    1,
  );
  const review = await f.store.command(f.admin, p.id, {
    action: "review",
    requestId: randomUUID(),
    expectedRevision: sent.task.revision,
    reason: "delivery_uncertain",
  });
  assert.equal(review.task.deliveryStatus, "pending");
  const resent = await f.store.command(f.admin, p.id, {
    ...delivery,
    requestId: randomUUID(),
    expectedRevision: review.task.revision,
  });
  assert.equal(resent.task.reviewReason, null);
  assert.equal(resent.task.deliveryStatus, "operator_reported");
  assert.deepEqual(await f.ledger.status(f.buyer.userId), before);
});
test("wrong gross amount, duplicate receipt, stale revision and forged authority fail before changing reports", async (t) => {
  const f = await fixture(t);
  const p = await f.addPayment();
  const claim = await claimed(f, p.id);
  const command = {
    action: "register",
    requestId: randomUUID(),
    expectedRevision: claim.task.revision,
    receiptId: "synthetic-receipt",
    receiptUrl: url("first"),
    amountKopeks: 9700,
    operatorReported: true,
  };
  await assert.rejects(f.store.command(f.admin, p.id, command), status(409));
  await assert.rejects(
    f.store.command(f.admin, p.id, {
      ...command,
      amountKopeks: 10000,
      approved: true,
    }),
    status(400),
  );
  const first = await f.store.command(f.admin, p.id, {
    ...command,
    amountKopeks: 10000,
  });
  await assert.rejects(
    f.store.command(f.admin, p.id, {
      ...command,
      requestId: randomUUID(),
      expectedRevision: first.task.revision,
      amountKopeks: 10000,
    }),
    status(409),
  );
  await assert.rejects(
    f.store.command(f.admin, p.id, {
      action: "review",
      requestId: randomUUID(),
      expectedRevision: 1,
      reason: "delivery_uncertain",
    }),
    status(409),
  );
  await assert.rejects(
    f.db.query(
      "update npd_receipt_tasks set amount_kopeks=9700,revision=revision+1 where id=$1",
      [p.id],
    ),
  );
});
test("active session, changed password, role, assignment and owner boundary are rechecked for every action", async (t) => {
  const f = await fixture(t);
  const p = await f.addPayment();
  const claim = await claimed(f, p.id);
  await assert.rejects(f.store.detailAdmin(f.buyer, p.id), status(403));
  await assert.rejects(
    f.store.command(f.second, p.id, {
      action: "review",
      requestId: randomUUID(),
      expectedRevision: claim.task.revision,
      reason: "registration_uncertain",
    }),
    status(409),
  );
  assert.deepEqual(await f.store.listOwner(f.other), { tasks: [] });
  const owner = await f.store.listOwner(f.buyer);
  assert.equal(owner.tasks.length, 1);
  assert.equal("buyerEmail" in owner.tasks[0]!, false);
  assert.equal("claimedByUserId" in owner.tasks[0]!, false);
  assert.equal("events" in owner.tasks[0]!, false);
  await f.db.query("update users set role='user' where id=$1", [
    f.admin.userId,
  ]);
  await assert.rejects(
    f.store.command(f.admin, p.id, {
      action: "claim",
      requestId: randomUUID(),
      expectedRevision: 2,
    }),
    status(403),
  );
  await assert.rejects(
    f.store.command(f.second, p.id, {
      action: "claim",
      requestId: randomUUID(),
      expectedRevision: 2,
    }),
    status(409),
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.second.userId,
  ]);
  await assert.rejects(f.store.listAdmin(f.second), status(403));
  await f.db.query("delete from sessions where token_hash=$1", [
    f.buyer.sessionTokenHash,
  ]);
  await assert.rejects(f.store.listOwner(f.buyer), status(401));
});
test("partial corrections preserve remaining income and documents; later refunds invalidate old snapshots and replay", async (t) => {
  const f = await fixture(t);
  const p = await f.addPayment();
  const original = await registered(f, p.id);
  const before = await f.ledger.status(f.buyer.userId);
  const first = await f.store.observeConfirmedRefund(
    observation(p.paymentId, f.buyer.userId, 3000),
  );
  assert.equal(first.task.correctionStatus, "required");
  assert.equal(first.task.remainingIncomeKopeks, 7000);
  const correction = {
    action: "correction",
    requestId: randomUUID(),
    expectedRevision: first.task.revision,
    refundSnapshotKopeks: 3000,
    canceledReceiptId: original.task.activeReceiptId,
    evidenceUrl: url("cancel-original"),
    replacement: {
      receiptId: "replacement-70",
      receiptUrl: url("replacement-70"),
      amountKopeks: 7000,
    },
    operatorReported: true,
  };
  await assert.rejects(
    f.store.command(f.admin, p.id, {
      ...correction,
      replacement: { ...correction.replacement, amountKopeks: 6999 },
    }),
    status(409),
  );
  const corrected = await f.store.command(f.admin, p.id, correction);
  assert.equal(corrected.task.correctionStatus, "operator_reported");
  const second = await f.store.observeConfirmedRefund(
    observation(p.paymentId, f.buyer.userId, 2000),
  );
  const replay = await f.store.command(f.admin, p.id, correction);
  assert.equal(replay.task.correctionStatus, "required");
  assert.equal(replay.task.revision, second.task.revision);
  await assert.rejects(
    f.store.command(f.admin, p.id, { ...correction, requestId: randomUUID() }),
    status(409),
  );
  const next = await f.store.command(f.admin, p.id, {
    ...correction,
    requestId: randomUUID(),
    expectedRevision: second.task.revision,
    refundSnapshotKopeks: 5000,
    canceledReceiptId: "replacement-70",
    replacement: {
      receiptId: "replacement-50",
      receiptUrl: url("replacement-50"),
      amountKopeks: 5000,
    },
  });
  assert.equal(next.task.remainingIncomeKopeks, 5000);
  const full = await f.store.observeConfirmedRefund(
    observation(p.paymentId, f.buyer.userId, 5000),
  );
  const canceled = await f.store.command(f.admin, p.id, {
    ...correction,
    requestId: randomUUID(),
    expectedRevision: full.task.revision,
    refundSnapshotKopeks: 10000,
    canceledReceiptId: "replacement-50",
    evidenceUrl: url("cancel-last"),
    replacement: null,
  });
  assert.equal(canceled.task.activeReceiptId, null);
  assert.equal(canceled.task.activeReceiptUrl, url("cancel-last"));
  assert.equal(canceled.task.remainingIncomeKopeks, 0);
  assert.equal(
    (await f.db.query("select * from npd_receipt_evidence")).rows.length,
    4,
  );
  assert.deepEqual(await f.ledger.status(f.buyer.userId), before);
});
test("trusted refund observations bind original live source, are bounded/idempotent and never money entries", async (t) => {
  const f = await fixture(t);
  const p = await f.addPayment();
  const input = observation(p.paymentId, f.buyer.userId, 3000);
  const first = await f.store.observeConfirmedRefund(input);
  const replay = await f.store.observeConfirmedRefund({
    ...input,
    observedAt: "2026-10-19T00:00:00.000Z",
  });
  assert.equal(first.task.revision, replay.task.revision);
  await assert.rejects(
    f.store.observeConfirmedRefund({ ...input, amountKopeks: 3001 }),
    status(409),
  );
  await assert.rejects(
    f.store.observeConfirmedRefund({
      ...input,
      providerRefundId: randomUUID(),
      amountKopeks: 8000,
    }),
    status(409),
  );
  await assert.rejects(
    f.store.observeConfirmedRefund({ ...input, merchantId: "wrong" }),
    status(409),
  );
  await assert.rejects(
    f.store.observeConfirmedRefund({ ...input, userId: f.other.userId }),
    status(409),
  );
  await assert.rejects(
    f.store.observeConfirmedRefund({ ...input, test: true } as never),
    status(400),
  );
  assert.equal(
    (await f.db.query("select * from npd_refund_observations")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select * from ai_credit_entries")).rows.length,
    1,
  );
});
test("queue keyset pagination, status filtering and receipt global uniqueness remain bounded", async (t) => {
  const f = await fixture(t);
  const first = await f.addPayment();
  await f.addPayment();
  await f.addPayment();
  const page = await f.store.listAdmin(f.admin, { limit: 1 });
  assert.equal(page.tasks.length, 1);
  assert.ok(page.nextAfter);
  const next = await f.store.listAdmin(f.admin, {
    after: page.nextAfter,
    limit: 100,
  });
  assert.equal(next.tasks.length, 2);
  assert.equal(next.nextAfter, null);
  assert.ok(next.tasks.every((task) => task.id !== page.tasks[0]!.id));
  const original = await registered(f, first.id);
  const another = (await f.store.listAdmin(f.admin, { status: "pending" }))
    .tasks[0]!;
  const claim = await claimed(f, another.id);
  await assert.rejects(
    f.store.command(f.admin, another.id, {
      ...original.input,
      requestId: randomUUID(),
      expectedRevision: claim.task.revision,
    }),
    status(409),
  );
  assert.equal(
    (await f.store.listAdmin(f.admin, { status: "registered" })).tasks.length,
    1,
  );
});

test("corrupt stored state or mismatched history fails closed as a generic server error, not a client validation error", async (t) => {
  const f = await fixture(t),
    p = await f.addPayment();
  const registeredTask = await registered(f, p.id);
  await assert.rejects(
    f.db.query(
      "update npd_receipt_tasks set active_evidence_id=null,revision=revision+1 where id=$1",
      [p.id],
    ),
  );
  // Explicit corruption only inside this disposable in-memory test database.
  await f.db.exec(
    "alter table npd_receipt_tasks disable trigger npd_receipt_task_guard",
  );
  await f.db.query(
    "update npd_receipt_tasks set active_evidence_id=null where id=$1",
    [p.id],
  );
  const serverError = (error: unknown) =>
    error instanceof Error &&
    !(error instanceof DomainError) &&
    error.message === "Stored NPD receipt data requires operator review";
  await assert.rejects(f.store.detailAdmin(f.admin, p.id), serverError);
  await assert.rejects(f.store.listOwner(f.buyer), serverError);
  await f.db.query(
    "update npd_receipt_tasks set active_evidence_id=$2 where id=$1",
    [p.id, registeredTask.task.activeEvidenceId],
  );
  await f.db.exec(
    "alter table npd_receipt_tasks enable trigger npd_receipt_task_guard",
  );
  await f.db.query(
    "update npd_receipt_commands set action='delivery' where request_id=$1",
    [registeredTask.input.requestId],
  );
  await assert.rejects(f.store.detailAdmin(f.admin, p.id), serverError);
});

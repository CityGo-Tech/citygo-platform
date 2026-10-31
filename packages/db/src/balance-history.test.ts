import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { serviceConsentPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  AiCreditLedger,
  BalanceHistory,
  DomainError,
  PaymentRefunds,
  type Database,
} from "./index.js";
import type { PaymentRefundObservation } from "./payment-refunds.js";
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    history = new BalanceHistory(db),
    ledger = new AiCreditLedger(db);
  const user = async (email: string, role = "user") => {
    const userId = await repo.register(email, "synthetic"),
      sessionTokenHash = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
    await repo.createSession(userId, sessionTokenHash);
    await new ServiceConsents(db).choose(userId, {
      policyVersion: serviceConsentPolicy.version,
      personalData: true,
      marketing: false,
    });
    await db.query("update users set role=$2 where id=$1", [userId, role]);
    return { userId, sessionTokenHash };
  };
  const owner = await user("history-owner@example.test"),
    other = await user("history-other@example.test"),
    admin = await user("history-admin@example.test", "super_admin");
  const topup = async (userId = owner.userId) => {
    const operationId = randomUUID(),
      paymentId = randomUUID();
    await ledger.topUpConfirmed(userId, operationId, {
      providerPaymentId: paymentId,
      merchantId: "synthetic-shop",
      test: false,
      paidKopeks: 10_000,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    return { operationId, paymentId };
  };
  return { db, repo, history, ledger, owner, other, admin, topup };
}
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
async function fingerprint(db: Database) {
  return (
    await db.query(
      `select json_build_object('accounts',(select jsonb_agg(a) from ai_credit_accounts a),'entries',(select jsonb_agg(e) from ai_credit_entries e),'allocations',(select jsonb_agg(a) from credit_refund_allocations a),'refunds',(select jsonb_agg(r) from payment_refunds r),'audit',(select count(*) from audit_log)) as state`,
    )
  ).rows;
}
test("history filters before pagination, keeps exact micros beyond operational rows, stable snapshot and duplicate-free tie keysets", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "select setval(pg_get_serial_sequence('ai_credit_entries','id'),9007199254740992)",
  );
  await f.ledger.grantWelcome(f.owner.userId, f.admin.userId);
  // More than the old status endpoint's 20 raw hold/release rows.
  for (let i = 0; i < 31; i++) {
    const hold = randomUUID();
    await f.ledger.hold(f.owner.userId, hold, 5_000_000);
    await f.ledger.resolve(f.owner.userId, randomUUID(), hold, {
      kind: "settle",
      amountMicros: 1_000_001 + i,
    });
    const release = randomUUID();
    await f.ledger.hold(f.owner.userId, release, 5_000_000);
    await f.ledger.resolve(f.owner.userId, randomUUID(), release, {
      kind: "release",
      amountMicros: 0,
    });
  }
  await f.topup(f.other.userId);
  // Deliberately same microsecond: IDs must use bigint comparison, not lexical sorting.
  await f.db.query(
    "update ai_credit_entries set created_at='2026-11-01T12:00:00.000001Z' where user_id=$1",
    [f.owner.userId],
  );
  const first = await f.history.list(f.owner, { filter: "spend" });
  assert.equal(first.entries.length, 20);
  assert.ok(first.nextCursor);
  assert.ok(
    BigInt(first.entries[0]!.id.split(":")[1]!) >
      BigInt(Number.MAX_SAFE_INTEGER),
  );
  assert.equal(first.entries[0]!.amountMicros, 1_000_031);
  const snapshot = await fingerprint(f.db);
  const second = await f.history.list(f.owner, {
    filter: "spend",
    cursor: first.nextCursor!,
  });
  assert.equal(second.entries.length, 11);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.entries, ...second.entries].map((e) => e.id)).size,
    31,
  );
  assert.ok(
    [...first.entries, ...second.entries].every(
      (e) => e.kind === "spend" && e.direction === "debit",
    ),
  );
  assert.deepEqual(await fingerprint(f.db), snapshot);
  const gift = await f.history.list(f.owner, { filter: "gift" });
  assert.equal(gift.entries.length, 1);
  assert.equal(gift.entries[0]!.amountMicros, 500_000_000);
  await f.topup();
  const rest = await f.history.list(f.owner, {
    filter: "spend",
    cursor: first.nextCursor!,
  });
  assert.deepEqual(rest, second);
  assert.equal((await f.history.list(f.other)).entries.length, 1);
  await assert.rejects(
    f.history.list(f.other, { filter: "spend", cursor: first.nextCursor! }),
    status(400),
  );
  await assert.rejects(
    f.history.list(f.owner, { filter: "topup", cursor: first.nextCursor! }),
    status(400),
  );
  const changed =
    first.nextCursor!.slice(0, -1) +
    (first.nextCursor!.endsWith("A") ? "B" : "A");
  await assert.rejects(
    f.history.list(f.owner, { filter: "spend", cursor: changed }),
    status(400),
  );
  const token = createHash("sha256").update(randomUUID()).digest("hex");
  await f.repo.createSession(f.owner.userId, token);
  await assert.rejects(
    f.history.list(
      { ...f.owner, sessionTokenHash: token },
      { filter: "spend", cursor: first.nextCursor! },
    ),
    status(400),
  );
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + 31 * 60_000);
  try {
    await assert.rejects(
      f.history.list(f.owner, { filter: "spend", cursor: first.nextCursor! }),
      status(409),
    );
  } finally {
    t.mock.restoreAll();
  }
});
test("only a confirmed settled refund appears once as debit, never a reservation, pending/create response, canceled or foreign refund", async (t) => {
  const f = await fixture(t),
    { operationId, paymentId } = await f.topup(),
    store = new PaymentRefunds(f.db);
  const created = await store.create(f.admin, {
      requestId: randomUUID(),
      paymentOperationId: operationId,
      amountKopeks: 2500,
    }),
    id = created.refund.id;
  assert.deepEqual(
    (await f.history.list(f.owner, { filter: "refund" })).entries,
    [],
  );
  const dispatch = await store.prepareDispatch(f.admin, id, {
    merchantId: "synthetic-shop",
    test: false,
  });
  const proof: PaymentRefundObservation = {
    id: randomUUID(),
    refundRequestId: id,
    paymentId,
    orderId: operationId,
    merchantId: "synthetic-shop",
    amountKopeks: 2500,
    currency: "RUB",
    test: false,
    refundedAmountKopeks: 2500,
    status: "succeeded",
    observation: "server_get",
    verifiedAt: new Date().toISOString(),
  };
  await store.recordCreate(id, dispatch.dispatch!.token, {
    ...proof,
    observation: "create_response",
  });
  assert.deepEqual(
    (await f.history.list(f.owner, { filter: "refund" })).entries,
    [],
  );
  await f.ledger.grantWelcome(f.owner.userId, f.admin.userId);
  for (let i = 0; i < 21; i++) {
    const hold = randomUUID();
    await f.ledger.hold(f.owner.userId, hold, 5_000_000);
    await f.ledger.resolve(f.owner.userId, randomUUID(), hold, {
      kind: "settle",
      amountMicros: 1,
    });
  }
  await f.db.query(
    "update ai_credit_entries set created_at='2099-11-01T12:00:00.000001Z' where user_id=$1",
    [f.owner.userId],
  );
  const priorPage = await f.history.list(f.owner);
  assert.ok(priorPage.nextCursor);
  await store.recordObservation(id, proof);
  const oldSnapshot = await f.history.list(f.owner, {
    cursor: priorPage.nextCursor!,
  });
  assert.ok(oldSnapshot.entries.every((entry) => entry.kind !== "refund"));
  const read = await f.history.list(f.owner, { filter: "refund" });
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0]!.amountMicros, 25_000_000);
  assert.equal(read.entries[0]!.direction, "debit");
  assert.ok(read.entries[0]!.id.startsWith("refund:"));
  await store.recordObservation(id, proof);
  assert.deepEqual(await f.history.list(f.owner, { filter: "refund" }), read);
  assert.deepEqual(
    (await f.history.list(f.other, { filter: "refund" })).entries,
    [],
  );
  const text = JSON.stringify(read);
  assert.doesNotMatch(
    text,
    /provider|merchant|paymentId|requestId|token|payload|hold/i,
  );
  const second = await store.create(f.admin, {
    requestId: randomUUID(),
    paymentOperationId: operationId,
    amountKopeks: 100,
  });
  await store.prepareDispatch(f.admin, second.refund.id, {
    merchantId: "synthetic-shop",
    test: false,
  });
  await store.recordObservation(second.refund.id, {
    ...proof,
    id: randomUUID(),
    refundRequestId: second.refund.id,
    amountKopeks: 100,
    status: "canceled",
    refundedAmountKopeks: 2500,
  });
  assert.deepEqual(await f.history.list(f.owner, { filter: "refund" }), read);
});
test("history refuses revoked sessions, blocked users, forced password change and missing service consent without creating accounts", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.history.list(f.owner)).entries, []);
  assert.equal(
    (await f.db.query("select * from ai_credit_accounts")).rows.length,
    0,
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner.userId,
  ]);
  await assert.rejects(f.history.list(f.owner), status(403));
  await f.db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [f.owner.userId],
  );
  await assert.rejects(f.history.list(f.owner), status(401));
  await f.db.query("update users set status='active' where id=$1", [
    f.owner.userId,
  ]);
  const missing = await f.repo.register(
      "unconsented@example.test",
      "synthetic",
    ),
    token = "e".repeat(64);
  await f.repo.createSession(missing, token);
  await assert.rejects(
    f.history.list({ userId: missing, sessionTokenHash: token }),
    status(403),
  );
  await f.db.query("delete from sessions where user_id=$1", [f.other.userId]);
  await assert.rejects(f.history.list(f.other), status(401));
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  paymentAdmissionCommandSchema,
  paymentAdmissionStatusSchema,
} from "@citygo/contracts";
import { connectDatabase, migrate, Repository, DomainError } from "./index.js";
import {
  PaymentAdmission,
  assertLiveCheckoutAdmission,
} from "./payment-admission.js";

const binding = { merchantId: "12345", runtimePolicyId: "a".repeat(64) };
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db);
  const owner = await repo.register("owner@example.test", "synthetic-password");
  const admin = await repo.register("admin@example.test", "synthetic-password");
  const buyer = await repo.register("buyer@example.test", "synthetic-password");
  await db.query(
    "update users set role=case when id=$1 then 'super_admin' else 'admin' end where id=$1 or id=$2",
    [owner, admin],
  );
  const contexts = [];
  for (const [userId, letter] of [
    [owner, "a"],
    [admin, "b"],
    [buyer, "c"],
  ] as const) {
    const sessionTokenHash = letter.repeat(64);
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [sessionTokenHash, userId],
    );
    contexts.push({ userId, sessionTokenHash });
  }
  const store = new PaymentAdmission(db, binding);
  return {
    db,
    store,
    owner: contexts[0]!,
    admin: contexts[1]!,
    buyer: contexts[2]!,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(f: Fixture, raw: Record<string, unknown>) {
  const state = await f.store.statusAdmin(f.owner);
  return f.store.command(f.owner, {
    requestId: randomUUID(),
    expectedRevision: state.revision,
    ...raw,
  });
}
async function healthy(f: Fixture) {
  await command(f, { action: "set_reconciliation", enabled: true });
  const run = await f.store.beginReconciliation();
  assert.ok(run);
  assert.equal(
    await f.store.completeReconciliation({ ...run, success: true }),
    true,
  );
}
async function continuous(f: Fixture) {
  return command(f, {
    action: "open",
    mode: "continuous",
    manualNpdResponsibilityAccepted: true,
  });
}

test("default closed, strict server binding, and exact explicit continuous acknowledgement", async (t) => {
  const f = await fixture(t);
  const state = await f.store.statusAdmin(f.owner);
  assert.equal(paymentAdmissionStatusSchema.parse(state).available, false);
  assert.equal(state.reason, "closed");
  assert.equal(state.reconciliationEnabled, false);
  assert.equal(state.npdBacklog.total, 0);
  assert.deepEqual(await f.store.statusUser(), { available: false });
  await assert.rejects(
    f.db.transaction((tx) => assertLiveCheckoutAdmission(tx, binding)),
    status(503),
  );
  assert.equal(
    paymentAdmissionCommandSchema.safeParse({
      action: "open",
      mode: "continuous",
      requestId: randomUUID(),
      expectedRevision: 1,
    }).success,
    false,
  );
  assert.equal(
    paymentAdmissionCommandSchema.safeParse({
      action: "open",
      mode: "lease",
      leaseSeconds: 3601,
      requestId: randomUUID(),
      expectedRevision: 1,
    }).success,
    false,
  );
  await assert.rejects(
    command(f, { action: "close", merchantId: "54321" }),
    status(400),
  );
  assert.throws(
    () => new PaymentAdmission(f.db, { ...binding, merchantId: "0123" }),
    status(400),
  );
  assert.throws(
    () =>
      new PaymentAdmission(f.db, { ...binding, runtimePolicyId: "invalid" }),
    status(400),
  );
});
test("commands require current active super admin session even before an idempotent replay", async (t) => {
  const f = await fixture(t);
  const cmd = { action: "close", requestId: randomUUID(), expectedRevision: 1 };
  await assert.rejects(f.store.command(f.admin, cmd), status(403));
  await assert.rejects(f.store.statusAdmin(f.buyer), status(403));
  await assert.rejects(
    f.store.command({ ...f.owner, sessionTokenHash: "d".repeat(64) }, cmd),
    status(401),
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner.userId,
  ]);
  await assert.rejects(f.store.command(f.owner, cmd), status(403));
  await f.db.query("update users set must_change_password=false where id=$1", [
    f.owner.userId,
  ]);
  await f.store.command(f.owner, cmd);
  await f.db.query("delete from sessions where token_hash=$1", [
    f.owner.sessionTokenHash,
  ]);
  await assert.rejects(f.store.command(f.owner, cmd), status(401));
  assert.equal(
    (await f.db.query("select * from payment_admission_commands")).rows.length,
    1,
  );
});
test("CAS, immutable command identity, replay never extends a lease or reopens a closed switch", async (t) => {
  const f = await fixture(t);
  const cmd = {
    action: "open",
    mode: "lease",
    leaseSeconds: 900,
    requestId: randomUUID(),
    expectedRevision: 1,
  };
  const first = await f.store.command(f.owner, cmd);
  const replay = await f.store.command(f.owner, cmd);
  assert.equal(replay.revision, 2);
  assert.equal(replay.leaseUntil, first.leaseUntil);
  await assert.rejects(
    f.store.command(f.owner, { ...cmd, leaseSeconds: 800 }),
    status(409),
  );
  await assert.rejects(
    f.store.command(f.owner, {
      action: "close",
      requestId: randomUUID(),
      expectedRevision: 1,
    }),
    status(409),
  );
  await command(f, { action: "close" });
  assert.equal((await f.store.command(f.owner, cmd)).mode, "closed");
  assert.equal(
    (await f.db.query("select * from payment_admission_commands")).rows.length,
    2,
  );
  await assert.rejects(
    f.db.query("update payment_admission_commands set result_revision=44"),
  );
  await assert.rejects(f.db.query("delete from payment_admission_commands"));
  await assert.rejects(f.db.exec("truncate payment_admission_commands"));
});
test("open and independent reconciliation health are both required, close preserves reconciliation", async (t) => {
  const f = await fixture(t);
  await continuous(f);
  assert.equal(
    (await f.store.statusAdmin(f.owner)).reason,
    "reconciliation_disabled",
  );
  await healthy(f);
  assert.equal((await f.store.statusUser()).available, true);
  await f.db.transaction((tx) => assertLiveCheckoutAdmission(tx, binding));
  await command(f, { action: "close" });
  assert.equal(
    (await f.store.statusAdmin(f.owner)).reconciliationEnabled,
    true,
  );
  assert.ok(await f.store.beginReconciliation());
  await assert.rejects(
    f.db.transaction((tx) => assertLiveCheckoutAdmission(tx, binding)),
    status(503),
  );
});
test("continuous checkout does not require operator online or session TTL, but current owner role remains mandatory", async (t) => {
  const f = await fixture(t);
  await continuous(f);
  await healthy(f);
  await f.db.query("delete from sessions where token_hash=$1", [
    f.owner.sessionTokenHash,
  ]);
  assert.equal((await f.store.statusUser()).available, true);
  await f.db.transaction((tx) => assertLiveCheckoutAdmission(tx, binding));
  await f.db.query("update users set role='admin' where id=$1", [
    f.owner.userId,
  ]);
  assert.equal((await f.store.statusUser()).available, false);
  await f.db.query(
    "update users set role='super_admin',must_change_password=true where id=$1",
    [f.owner.userId],
  );
  assert.equal((await f.store.statusUser()).available, false);
  await f.db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [f.owner.userId],
  );
  assert.equal((await f.store.statusUser()).available, false);
});
test("lease expiry/session expiry is DB-clock based and non-leased continuous mode remains distinct", async (t) => {
  const f = await fixture(t);
  await command(f, { action: "open", mode: "lease" });
  await healthy(f);
  assert.equal((await f.store.statusUser()).available, true);
  await f.db.query(
    "update sessions set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1",
    [f.owner.sessionTokenHash],
  );
  assert.equal((await f.store.statusUser()).available, false);
  await assert.rejects(
    f.db.transaction((tx) => assertLiveCheckoutAdmission(tx, binding)),
    status(503),
  );
  await f.db.query(
    "update sessions set expires_at=clock_timestamp()+interval '1 day' where token_hash=$1",
    [f.owner.sessionTokenHash],
  );
  await f.db.query(
    "update payment_admission set lease_until=clock_timestamp()-interval '1 second'",
  );
  assert.equal((await f.store.statusAdmin(f.owner)).reason, "lease_expired");
});
test("heartbeat is bound, bounded, exclusive, DB-timed, fail-closed and append-only", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.store.beginReconciliation(), null);
  await continuous(f);
  await command(f, { action: "set_reconciliation", enabled: true });
  const run = await f.store.beginReconciliation();
  assert.ok(run);
  assert.equal(await f.store.beginReconciliation(), null);
  assert.equal(
    await f.store.completeReconciliation({
      ...run,
      runId: randomUUID(),
      success: true,
    }),
    false,
  );
  assert.equal(
    await f.store.completeReconciliation({ ...run, success: true }),
    true,
  );
  assert.equal(
    await f.store.completeReconciliation({ ...run, success: true }),
    false,
  );
  assert.equal((await f.store.statusUser()).available, true);
  await f.db.query(
    "update payment_admission set reconciliation_checked_at=clock_timestamp()-interval '121 seconds'",
  );
  assert.equal(
    (await f.store.statusAdmin(f.owner)).reason,
    "reconciliation_stale",
  );
  const failed = await f.store.beginReconciliation();
  assert.ok(failed);
  await f.store.completeReconciliation({ ...failed, success: false });
  assert.equal(
    (await f.store.statusAdmin(f.owner)).reason,
    "reconciliation_unhealthy",
  );
  assert.equal(
    (await f.db.query("select * from payment_admission_reconciliation_events"))
      .rows.length,
    2,
  );
  await assert.rejects(
    f.db.exec("truncate payment_admission_reconciliation_events"),
  );
  await assert.rejects(
    f.db.query("delete from payment_admission_reconciliation_events"),
  );
});
test("stale runs cannot repair health after revision/disable/rebind or expire, new runtime cannot reuse old admission", async (t) => {
  const f = await fixture(t);
  await continuous(f);
  await command(f, { action: "set_reconciliation", enabled: true });
  const old = await f.store.beginReconciliation();
  assert.ok(old);
  await command(f, { action: "set_reconciliation", enabled: false });
  assert.equal(
    await f.store.completeReconciliation({ ...old, success: true }),
    false,
  );
  await command(f, { action: "set_reconciliation", enabled: true });
  const expired = await f.store.beginReconciliation();
  assert.ok(expired);
  await f.db.query(
    "update payment_admission set reconciliation_run_until=clock_timestamp()-interval '1 second'",
  );
  assert.equal(
    await f.store.completeReconciliation({ ...expired, success: true }),
    false,
  );
  const fresh = await f.store.beginReconciliation();
  assert.ok(fresh);
  assert.notEqual(fresh.runId, expired.runId);
  assert.equal(
    await f.store.completeReconciliation({ ...fresh, success: true }),
    true,
  );
  const other = new PaymentAdmission(f.db, {
    ...binding,
    runtimePolicyId: "b".repeat(64),
  });
  assert.equal((await other.statusAdmin(f.owner)).reason, "binding_mismatch");
  assert.equal(await other.beginReconciliation(), null);
  await assert.rejects(
    f.db.transaction((tx) =>
      assertLiveCheckoutAdmission(tx, {
        ...binding,
        runtimePolicyId: "b".repeat(64),
      }),
    ),
    status(503),
  );
  const oldState = await f.store.statusAdmin(f.owner);
  const rebound = await other.command(f.owner, {
    action: "open",
    mode: "continuous",
    manualNpdResponsibilityAccepted: true,
    expectedRevision: oldState.revision,
    requestId: randomUUID(),
  });
  assert.equal(rebound.reconciliationEnabled, false);
  assert.equal(rebound.available, false);
  assert.equal((await f.store.statusUser()).available, false);
});

test("last revision is reserved for closure, never an unclosable continuous opening", async (t) => {
  const f = await fixture(t);
  await f.db.query("update payment_admission set revision=2147483646");
  await assert.rejects(continuous(f), status(409));
  const closed = await command(f, { action: "close" });
  assert.equal(closed.revision, 2147483647);
  assert.equal(closed.available, false);
  assert.equal(closed.mode, "closed");
});

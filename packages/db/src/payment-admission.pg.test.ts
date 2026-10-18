import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  DomainError,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";
import {
  PaymentAdmission,
  type PaymentAdmissionContext,
} from "./payment-admission.js";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { AiCreditLedger } from "./ai-credit.js";

// Opt-in, disposable loopback PostgreSQL only. No .env, provider HTTP, Docker,
// production role names or application databases are used by this fixture.
const testUrl = process.env.TEST_DATABASE_URL;
const pgOnly = {
  skip: testUrl
    ? false
    : "Requires opt-in disposable loopback PostgreSQL; skipped tests are not race/ACL evidence",
  timeout: 60_000,
};
const binding = { merchantId: "12345", runtimePolicyId: "a".repeat(64) };
const returnUrl = "https://citygo.example.test/synthetic-balance";
const admissionColumns = [
  "revision",
  "merchant_id",
  "runtime_policy_id",
  "accepting_new_checkouts",
  "reconciliation_enabled",
  "mode",
  "owner_user_id",
  "lease_session_token_hash",
  "lease_until",
  "manual_npd_responsibility_accepted",
  "reconciliation_checked_at",
  "reconciliation_ok",
  "reconciliation_run_id",
  "reconciliation_run_revision",
  "reconciliation_run_until",
  "updated_at",
];
const isStatus = (status: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === status;

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic admission barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
// A deliberately paused query may fail before a barrier is reached. Keep the
// original promise observable without an unrelated unhandled-rejection failure.
function watched<T>(work: Promise<T>) {
  void work.catch(() => {});
  return work;
}
function named(db: Database, tag: string, pauseAfter?: string) {
  const entered = barrier(),
    release = barrier();
  let held = false,
    blockerPid = 0;
  const wrapper: Database = {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        const pid = (
          await tx.query<{ pid: number }>("select pg_backend_pid() as pid")
        ).rows[0]!.pid;
        return work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (!held && pauseAfter && sql.includes(pauseAfter)) {
              held = true;
              blockerPid = pid;
              entered.release();
              await release.promise;
            }
            return result;
          },
        });
      }),
  };
  return { db: wrapper, entered, release, pid: () => blockerPid };
}
async function waiting(db: Sql, tag: string, blockerPid: number) {
  assert.ok(blockerPid > 0, "The specific lock holder must be known");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = (
      await db.query(
        `select pid from pg_stat_activity where datname=current_database()
       and application_name=$1 and wait_event_type='Lock'
       and $2::integer=any(pg_blocking_pids(pid))`,
        [tag, blockerPid],
      )
    ).rows;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Expected admission contender was not observed waiting for the specific blocker",
  );
}

async function fixture(t: TestContext) {
  assert.ok(testUrl);
  const url = new URL(testUrl);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(["5432", "55438"].includes(url.port || "5432"));
  assert.ok(["/citygo_test", "/citygo_synthetic"].includes(url.pathname));
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const suffix = randomUUID().replaceAll("-", "");
  const database = "cg_admission_" + suffix;
  assert.match(database, /^cg_admission_[a-f0-9]{32}$/);
  const resources: { admin?: Database; db?: Database } = {};
  const roles: string[] = [];
  let created = false;
  t.after(async () => {
    const failures: unknown[] = [];
    for (const action of [
      async () => resources.db?.close(),
      async () => {
        if (created)
          await resources.admin!.query(`drop database "${database}"`);
      },
      ...roles.map(
        (role) => async () => resources.admin!.query(`drop role "${role}"`),
      ),
      async () => resources.admin?.close(),
    ]) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic admission cleanup failed");
  });
  const admin = await connectDatabase(testUrl);
  resources.admin = admin;
  await admin.query(`create database "${database}" template template0`);
  created = true;
  url.pathname = "/" + database;
  const db = await connectDatabase(url.toString());
  resources.db = db;
  await migrate(db);
  const repo = new Repository(db);
  const contexts: PaymentAdmissionContext[] = [];
  for (const [index, label] of ["owner", "second-owner", "buyer"].entries()) {
    const userId = await repo.register(
      `${label}@example.test`,
      "synthetic-password-hash",
    );
    const sessionTokenHash = String(index + 1).repeat(64);
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [sessionTokenHash, userId],
    );
    contexts.push({ userId, sessionTokenHash });
  }
  const [owner, second, buyer] = contexts as [
    PaymentAdmissionContext,
    PaymentAdmissionContext,
    PaymentAdmissionContext,
  ];
  await db.query(
    "update users set role='super_admin',must_change_password=false where id=$1 or id=$2",
    [owner.userId, second.userId],
  );
  return {
    db,
    admin,
    owner,
    second,
    buyer,
    roles,
    suffix,
    store: new PaymentAdmission(db, binding),
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
async function ready(f: Fixture) {
  await command(f, {
    action: "open",
    mode: "continuous",
    manualNpdResponsibilityAccepted: true,
  });
  await command(f, { action: "set_reconciliation", enabled: true });
  const run = await f.store.beginReconciliation();
  assert.ok(run);
  assert.equal(
    await f.store.completeReconciliation({ ...run, success: true }),
    true,
  );
  assert.deepEqual(await f.store.statusUser(), { available: true });
  return (await f.store.statusAdmin(f.owner)).revision;
}
function createOrder(f: Fixture, db: Database, requestId = randomUUID()) {
  return new PaymentTopupOrders(db, binding).create(
    f.buyer.userId,
    requestId,
    10000,
    binding.merchantId,
    false,
    returnUrl,
  );
}

test(
  "PostgreSQL admission CAS: two super admins with one revision serialize to one command and one conflict",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const tag = "admission_cas_" + f.suffix;
    const gate = named(
      f.db,
      tag + "_first",
      "select id from payment_admission where id=1 for update",
    );
    const firstCommand = {
      action: "close",
      expectedRevision: 1,
      requestId: randomUUID(),
    };
    const winner = watched(
      new PaymentAdmission(gate.db, binding).command(f.owner, firstCommand),
    );
    let rejected: Promise<void> | undefined;
    try {
      await within(gate.entered.promise);
      rejected = assert.rejects(
        new PaymentAdmission(named(f.db, tag).db, binding).command(f.second, {
          action: "set_reconciliation",
          enabled: true,
          expectedRevision: 1,
          requestId: randomUUID(),
        }),
        isStatus(409),
      );
      await waiting(f.db, tag, gate.pid());
    } finally {
      gate.release.release();
    }
    const result = await within(winner);
    assert.ok(rejected);
    await within(rejected);
    assert.equal(result.revision, 2);
    assert.deepEqual(await f.store.command(f.owner, firstCommand), result);
    const rows = (
      await f.db.query<{ request_id: string; result_revision: number }>(
        "select request_id,result_revision from payment_admission_commands",
      )
    ).rows;
    assert.deepEqual(rows, [
      { request_id: firstCommand.requestId, result_revision: 2 },
    ]);
    assert.equal(
      (await f.store.statusAdmin(f.owner)).reconciliationEnabled,
      false,
    );
  },
);

test(
  "PostgreSQL closing before bound live order admission prevents durable order and rolls back mode changes",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      revision = await ready(f);
    const tag = "admission_close_first_" + f.suffix;
    const gate = named(
      f.db,
      tag + "_close",
      "select id from payment_admission where id=1 for update",
    );
    const close = watched(
      new PaymentAdmission(gate.db, binding).command(f.owner, {
        action: "close",
        requestId: randomUUID(),
        expectedRevision: revision,
      }),
    );
    let rejected: Promise<void> | undefined;
    try {
      await within(gate.entered.promise);
      rejected = assert.rejects(
        createOrder(f, named(f.db, tag).db),
        isStatus(503),
      );
      await waiting(f.db, tag, gate.pid());
    } finally {
      gate.release.release();
    }
    assert.equal((await within(close)).mode, "closed");
    assert.ok(rejected);
    await within(rejected);
    assert.equal(
      (await f.db.query("select 1 from payment_topup_orders")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("select 1 from ai_credit_topups")).rows.length,
      0,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select real_ai_admitted,test_payments_seen from account_security_state where id=1",
        )
      ).rows,
      [{ real_ai_admitted: false, test_payments_seen: false }],
    );
    const closed = await f.store.statusAdmin(f.owner);
    assert.equal(closed.available, false);
    assert.equal(closed.reconciliationEnabled, true);
  },
);

test(
  "PostgreSQL bound order before closure persists, but replay is gated while settlement and receipts remain possible",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      revision = await ready(f);
    const tag = "admission_order_first_" + f.suffix;
    const gate = named(
      f.db,
      tag + "_order",
      "select id from payment_admission where id=1 for update",
    );
    const requestId = randomUUID();
    const created = watched(createOrder(f, gate.db, requestId));
    let close: ReturnType<PaymentAdmission["command"]> | undefined;
    try {
      await within(gate.entered.promise);
      close = watched(
        new PaymentAdmission(named(f.db, tag).db, binding).command(f.owner, {
          action: "close",
          requestId: randomUUID(),
          expectedRevision: revision,
        }),
      );
      await waiting(f.db, tag, gate.pid());
    } finally {
      gate.release.release();
    }
    const order = await within(created);
    assert.ok(close);
    assert.equal((await within(close)).available, false);
    assert.equal(order.status, "queued");
    assert.equal(
      (await f.db.query("select 1 from payment_topup_orders")).rows.length,
      1,
    );
    await assert.rejects(createOrder(f, f.db, requestId), isStatus(503));
    const orders = new PaymentTopupOrders(f.db, binding),
      payment = randomUUID();
    await orders.recordProvider(f.buyer.userId, order.id, {
      providerPaymentId: payment,
      status: "pending",
    });
    // Synthetic direct domain observation, not provider HTTP or real payment proof.
    const ledger = new AiCreditLedger(f.db);
    await ledger.topUpConfirmed(f.buyer.userId, order.id, {
      providerPaymentId: payment,
      merchantId: binding.merchantId,
      test: false,
      paidKopeks: 10000,
      verifiedAt: "2026-10-19T10:00:00.000Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    const settled = await orders.recordProvider(f.buyer.userId, order.id, {
      providerPaymentId: payment,
      status: "succeeded",
    });
    assert.equal(settled.credited, true);
    assert.equal(
      (await ledger.status(f.buyer.userId)).availableMicros,
      100_000_000,
    );
    assert.equal(
      (
        await f.db.query("select 1 from npd_receipt_tasks where id=$1", [
          order.id,
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (await orders.get(f.buyer.userId, order.id)).status,
      "succeeded",
    );
    assert.equal(
      (await f.store.statusAdmin(f.owner)).reconciliationEnabled,
      true,
    );
    assert.deepEqual(await f.store.statusUser(), { available: false });
  },
);

test(
  "PostgreSQL reconciliation lease excludes overlapping runs; expired and superseded tokens cannot publish health",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    await command(f, { action: "set_reconciliation", enabled: true });
    const tag = "admission_run_" + f.suffix;
    const gate = named(
      f.db,
      tag + "_first",
      "reconciliation_run_id=$1,reconciliation_run_revision=revision",
    );
    const first = watched(
      new PaymentAdmission(gate.db, binding).beginReconciliation(),
    );
    let contender:
      ReturnType<PaymentAdmission["beginReconciliation"]> | undefined;
    try {
      await within(gate.entered.promise);
      contender = watched(
        new PaymentAdmission(
          named(f.db, tag).db,
          binding,
        ).beginReconciliation(),
      );
      await waiting(f.db, tag, gate.pid());
    } finally {
      gate.release.release();
    }
    const old = await within(first);
    assert.ok(old);
    assert.ok(contender);
    assert.equal(await within(contender), null);
    await f.db.query(
      "update payment_admission set reconciliation_run_until=clock_timestamp()-interval '1 second' where id=1",
    );
    assert.equal(
      await f.store.completeReconciliation({ ...old, success: true }),
      false,
    );
    const fresh = await f.store.beginReconciliation();
    assert.ok(fresh);
    assert.notEqual(fresh.runId, old.runId);
    assert.equal(
      await f.store.completeReconciliation({ ...old, success: true }),
      false,
    );
    assert.equal(
      await f.store.completeReconciliation({ ...fresh, success: true }),
      true,
    );
    assert.equal(
      await f.store.completeReconciliation({ ...fresh, success: true }),
      false,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select run_id,admission_revision,success from payment_admission_reconciliation_events",
        )
      ).rows,
      [
        {
          run_id: fresh.runId,
          admission_revision: fresh.revision,
          success: true,
        },
      ],
    );
    await f.db.query(
      "update payment_admission set reconciliation_checked_at=clock_timestamp()-interval '121 seconds' where id=1",
    );
    await command(f, {
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: true,
    });
    assert.equal(
      (await f.store.statusAdmin(f.owner)).reason,
      "reconciliation_stale",
    );
  },
);

test(
  "PostgreSQL disable wins against an in-flight completion; re-enable and runtime rebinding fence prior runs",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      revision = await ready(f);
    const old = await f.store.beginReconciliation();
    assert.ok(old);
    const tag = "admission_disable_" + f.suffix;
    const gate = named(
      f.db,
      tag + "_command",
      "select id from payment_admission where id=1 for update",
    );
    const disabled = watched(
      new PaymentAdmission(gate.db, binding).command(f.owner, {
        action: "set_reconciliation",
        enabled: false,
        requestId: randomUUID(),
        expectedRevision: revision,
      }),
    );
    let completion:
      ReturnType<PaymentAdmission["completeReconciliation"]> | undefined;
    try {
      await within(gate.entered.promise);
      completion = watched(
        new PaymentAdmission(
          named(f.db, tag).db,
          binding,
        ).completeReconciliation({ ...old, success: true }),
      );
      await waiting(f.db, tag, gate.pid());
    } finally {
      gate.release.release();
    }
    assert.equal((await within(disabled)).reconciliationEnabled, false);
    assert.ok(completion);
    assert.equal(await within(completion), false);
    assert.equal(await f.store.beginReconciliation(), null);
    await command(f, { action: "set_reconciliation", enabled: true });
    const fresh = await f.store.beginReconciliation();
    assert.ok(fresh);
    assert.ok(fresh.revision > old.revision);
    assert.equal(
      await f.store.completeReconciliation({ ...old, success: true }),
      false,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select reconciliation_run_id from payment_admission where id=1",
        )
      ).rows,
      [{ reconciliation_run_id: fresh.runId }],
    );
    const rebound = new PaymentAdmission(f.db, {
      ...binding,
      runtimePolicyId: "b".repeat(64),
    });
    assert.equal(
      (await rebound.statusAdmin(f.owner)).reason,
      "binding_mismatch",
    );
    assert.equal(await rebound.beginReconciliation(), null);
    await rebound.command(f.owner, {
      action: "close",
      requestId: randomUUID(),
      expectedRevision: fresh.revision,
    });
    assert.equal(
      await f.store.completeReconciliation({ ...fresh, success: true }),
      false,
    );
    assert.equal(await f.store.beginReconciliation(), null);
    const state = await rebound.statusAdmin(f.owner);
    assert.equal(state.reconciliationEnabled, false);
    assert.equal(state.reconciliationOk, false);
    assert.equal(state.reconciliationCheckedAt, null);
    assert.equal(
      (
        await f.db.query(
          "select 1 from payment_admission_reconciliation_events",
        )
      ).rows.length,
      1,
    );
  },
);

type Grant = { table: string; privileges: string[]; columns?: string[] };
const runtimeGrants: Grant[] = [
  { table: "users", privileges: ["select", "update"] },
  { table: "sessions", privileges: ["select"] },
  { table: "sessions", privileges: ["update"], columns: ["expires_at"] },
  { table: "account_security_state", privileges: ["select"] },
  {
    table: "account_security_state",
    privileges: ["update"],
    columns: ["bootstrap_completed", "test_payments_seen", "real_ai_admitted"],
  },
  { table: "payment_admission", privileges: ["select"] },
  {
    table: "payment_admission",
    privileges: ["update"],
    columns: admissionColumns,
  },
  { table: "payment_admission_commands", privileges: ["select", "insert"] },
  {
    table: "payment_admission_reconciliation_events",
    privileges: ["select", "insert"],
  },
  { table: "npd_receipt_tasks", privileges: ["select"] },
  { table: "payment_topup_orders", privileges: ["select", "insert"] },
  {
    table: "payment_topup_orders",
    privileges: ["update"],
    columns: [
      "provider_payment_id",
      "status",
      "confirmation_url",
      "updated_at",
    ],
  },
  { table: "ai_credit_topups", privileges: ["select"] },
];
function sourceApiGrants(source: string): Grant[] {
  const result: Grant[] = [];
  for (const statement of source
    .replace(/^\\set[^\r\n]*$/gm, "")
    .replace(/--[^\r\n]*/g, "")
    .split(";")) {
    const match = statement
      .trim()
      .replace(/\s+/g, " ")
      .match(/^grant (.+) on (.+) to citygo_api$/i);
    if (!match || match[2]!.startsWith("all sequences")) continue;
    const columns = match[1]!.match(/^update\s*\(([^)]+)\)$/i);
    const privileges = columns
      ? ["update"]
      : match[1]!.split(",").map((part) => part.trim());
    for (const table of match[2]!.split(",").map((part) => part.trim()))
      result.push({
        table,
        privileges,
        ...(columns
          ? { columns: columns[1]!.split(",").map((part) => part.trim()) }
          : {}),
      });
  }
  return result;
}
async function checkedRuntimeGrants() {
  const source = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  const actual = sourceApiGrants(source);
  for (const wanted of runtimeGrants) {
    for (const privilege of wanted.privileges)
      assert.ok(
        actual.some(
          (grant) =>
            grant.table === wanted.table &&
            grant.privileges.includes(privilege) &&
            (!grant.columns ||
              (wanted.columns &&
                wanted.columns.every((column) =>
                  grant.columns!.includes(column),
                ))),
        ),
        `Fixture privilege must be permitted by reviewed production grants: ${wanted.table}/${privilege}`,
      );
  }
  for (const table of [
    "payment_admission",
    "payment_admission_commands",
    "payment_admission_reconciliation_events",
  ]) {
    const grants = actual.filter((grant) => grant.table === table);
    assert.deepEqual(
      grants.map((grant) => ({
        ...grant,
        privileges: [...grant.privileges].sort(),
        ...(grant.columns ? { columns: [...grant.columns].sort() } : {}),
      })),
      runtimeGrants
        .filter((grant) => grant.table === table)
        .map((grant) => ({
          ...grant,
          privileges: [...grant.privileges].sort(),
          ...(grant.columns ? { columns: [...grant.columns].sort() } : {}),
        })),
      "Admission singleton/history privileges must not silently broaden",
    );
  }
  return runtimeGrants;
}

test("admission PostgreSQL fixture privileges remain a checked subset of deploy grants, with no broad history/singleton rights", async () => {
  await checkedRuntimeGrants();
});

test(
  "PostgreSQL narrow API role can admit/synchronize/close, while Worker and history rewrites are denied",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const apiRole = "cg_adm_api_" + f.suffix,
      workerRole = "cg_adm_worker_" + f.suffix;
    for (const role of [apiRole, workerRole]) {
      assert.match(role, /^cg_adm_(?:api|worker)_[a-f0-9]{32}$/);
      await f.admin.query(
        `create role "${role}" nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit`,
      );
      f.roles.push(role);
      await f.db.exec(`grant usage on schema public to "${role}"`);
      assert.deepEqual(
        (
          await f.db.query(
            "select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=$1",
            [role],
          )
        ).rows,
        [
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ],
      );
    }
    for (const grant of await checkedRuntimeGrants()) {
      const privileges = grant.columns
        ? `update (${grant.columns.join(",")})`
        : grant.privileges.join(",");
      await f.db.exec(
        `grant ${privileges} on public.${grant.table} to "${apiRole}"`,
      );
    }
    function asRole(role: string): Database {
      assert.ok([apiRole, workerRole].includes(role));
      const transaction = <T>(work: (sql: Sql) => Promise<T>) =>
        f.db.transaction(async (tx) => {
          await tx.exec(`set local role "${role}"`);
          return work(tx);
        });
      return {
        query: (sql, params) => transaction((tx) => tx.query(sql, params)),
        exec: (sql) => transaction((tx) => tx.exec(sql)),
        transaction,
        close: async () => {},
      };
    }
    const api = asRole(apiRole),
      worker = asRole(workerRole);
    assert.deepEqual((await api.query("select current_user as role")).rows, [
      { role: apiRole },
    ]);
    const store = new PaymentAdmission(api, binding);
    let state = await store.statusAdmin(f.owner);
    assert.equal(state.available, false);
    await assert.rejects(store.statusAdmin(f.buyer), isStatus(403));
    state = await store.command(f.owner, {
      action: "set_reconciliation",
      enabled: true,
      requestId: randomUUID(),
      expectedRevision: state.revision,
    });
    state = await store.command(f.owner, {
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: true,
      requestId: randomUUID(),
      expectedRevision: state.revision,
    });
    const run = await store.beginReconciliation();
    assert.ok(run);
    assert.equal(
      await store.completeReconciliation({ ...run, success: true }),
      true,
    );
    assert.equal((await store.statusUser()).available, true);
    const order = await createOrder(f, api);
    assert.equal(order.status, "queued");
    state = await store.command(f.owner, {
      action: "close",
      requestId: randomUUID(),
      expectedRevision: state.revision,
    });
    assert.equal(state.available, false);
    assert.equal(state.reconciliationEnabled, true);
    assert.ok(await store.beginReconciliation());
    const history = (
      await api.query(
        "select * from payment_admission_commands order by result_revision",
      )
    ).rows;
    const events = (
      await api.query("select * from payment_admission_reconciliation_events")
    ).rows;
    for (const sql of [
      "insert into payment_admission(id) values(1)",
      "update payment_admission set id=1",
      "update payment_admission set created_at=clock_timestamp()",
      "delete from payment_admission",
      "truncate payment_admission",
      "update payment_admission_commands set result_revision=result_revision",
      "delete from payment_admission_commands",
      "truncate payment_admission_commands",
      "update payment_admission_reconciliation_events set success=not success",
      "delete from payment_admission_reconciliation_events",
      "truncate payment_admission_reconciliation_events",
    ])
      await assert.rejects(api.exec(sql), { code: "42501" });
    for (const table of [
      "payment_admission",
      "payment_admission_commands",
      "payment_admission_reconciliation_events",
    ])
      await assert.rejects(worker.query(`select * from ${table}`), {
        code: "42501",
      });
    // Even table owners cannot rewrite or truncate existing admission history.
    for (const table of [
      "payment_admission_commands",
      "payment_admission_reconciliation_events",
    ]) {
      for (const sql of [
        `update ${table} set created_at=created_at`,
        `delete from ${table}`,
        `truncate ${table}`,
      ])
        await assert.rejects(f.db.exec(sql), { code: "23514" });
    }
    assert.deepEqual(
      (
        await api.query(
          "select * from payment_admission_commands order by result_revision",
        )
      ).rows,
      history,
    );
    assert.deepEqual(
      (await api.query("select * from payment_admission_reconciliation_events"))
        .rows,
      events,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select prosecdef from pg_proc where proname='citygo_guard_payment_admission_history' and pronamespace=current_schema()::regnamespace",
        )
      ).rows,
      [{ prosecdef: false }],
    );
  },
);

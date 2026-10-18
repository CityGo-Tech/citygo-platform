import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { AccountAccess } from "./account-access.js";
import { AiCreditLedger } from "./ai-credit.js";
import {
  connectDatabase,
  DomainError,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";
import {
  PaymentRefunds,
  type PaymentRefundContext,
  type PaymentRefundObservation,
} from "./payment-refunds.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in localhost disposable PostgreSQL; PGlite is not race evidence",
  timeout: 60_000,
};
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic refund-journal barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waiting(db: Sql) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      (
        await db.query(
          "select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'",
        )
      ).rows.length
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic refund-journal lock wait was not observed");
}
function paused(db: Database, match: string) {
  const entered = signal(),
    release = signal();
  let held = false;
  const wrapper: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (!held && sql.includes(match)) {
              held = true;
              entered.open();
              await release.promise;
            }
            return result;
          },
        }),
      ),
  };
  return { db: wrapper, entered, release };
}
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(["5432", "55438"].includes(url.port || "5432"));
  assert.ok(["/citygo_test", "/citygo_synthetic"].includes(url.pathname));
  assert.equal(url.search, "");
  const name = "cg_refund_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_refund_test_[a-f0-9]{32}$/);
  const adminDb = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await adminDb.query(`drop database "${name}"`);
    } finally {
      await adminDb.close();
    }
  });
  await adminDb.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  const repo = new Repository(db),
    contexts: PaymentRefundContext[] = [];
  for (const [i, name] of ["super", "operator", "buyer"].entries()) {
    const userId = await repo.register(`${name}@example.test`, "synthetic"),
      sessionTokenHash = String(i + 1).repeat(64);
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [sessionTokenHash, userId],
    );
    contexts.push({ userId, sessionTokenHash });
  }
  const [first, second, buyer] = contexts as [
    PaymentRefundContext,
    PaymentRefundContext,
    PaymentRefundContext,
  ];
  await db.query("update users set role='super_admin' where id=$1", [
    first.userId,
  ]);
  await db.query("update users set role='admin' where id=$1", [second.userId]);
  const ledger = new AiCreditLedger(db),
    store = new PaymentRefunds(db),
    source = randomUUID(),
    payment = randomUUID();
  await ledger.topUpConfirmed(buyer.userId, source, {
    providerPaymentId: payment,
    merchantId: "synthetic-shop",
    test: false,
    paidKopeks: 10000,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const command = () => ({
    requestId: randomUUID(),
    paymentOperationId: source,
    amountKopeks: 2500,
  });
  const proof = (id: string): PaymentRefundObservation => ({
    id: randomUUID(),
    refundRequestId: id,
    paymentId: payment,
    orderId: source,
    merchantId: "synthetic-shop",
    test: false,
    amountKopeks: 2500,
    currency: "RUB",
    refundedAmountKopeks: 2500,
    status: "succeeded",
    observation: "server_get",
    verifiedAt: "2026-10-18T00:01:00.000Z",
  });
  return { db, first, second, buyer, ledger, store, source, command, proof };
}

test(
  "PostgreSQL concurrent refund administrators create only one durable paid reservation",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      gate = paused(
        f.db,
        "select user_id from ai_credit_accounts where user_id=$1 for update",
      );
    const winner = new PaymentRefunds(gate.db).create(f.first, f.command());
    await within(gate.entered.promise);
    const loser = f.store.create(f.second, f.command());
    const rejected = assert.rejects(
      loser,
      (e) => e instanceof DomainError && e.statusCode === 409,
    );
    try {
      await waiting(f.db);
    } finally {
      gate.release.open();
    }
    const result = await within(winner);
    await within(rejected);
    assert.equal(result.refund.status, "reserved");
    assert.equal(
      (await f.db.query("select * from payment_refunds")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select * from credit_refund_allocations")).rows.length,
      1,
    );
    const status = await f.ledger.status(f.buyer.userId);
    assert.equal(status.heldMicros, 25_000_000);
    assert.equal(status.availableMicros, 75_000_000);
  },
);

test(
  "PostgreSQL repeated concurrent authenticated GET observations post one refund and one NPD obligation",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      created = await f.store.create(f.first, f.command()),
      proof = f.proof(created.refund.id);
    const gate = paused(
      f.db,
      "select user_id from ai_credit_accounts where user_id=$1 for update",
    );
    const winner = new PaymentRefunds(gate.db).recordObservation(
      created.refund.id,
      proof,
    );
    await within(gate.entered.promise);
    const replay = f.store.recordObservation(created.refund.id, proof);
    try {
      await waiting(f.db);
    } finally {
      gate.release.open();
    }
    const result = await within(winner),
      second = await within(replay);
    assert.equal(result.refund.status, "succeeded");
    assert.deepEqual(second, result);
    const status = await f.ledger.status(f.buyer.userId);
    assert.equal(status.grantedMicros, 75_000_000);
    assert.equal(status.heldMicros, 0);
    assert.equal(status.spentMicros, 0);
    assert.equal(
      (
        await f.db.query(
          "select * from credit_refund_allocations where state='settled'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select * from npd_refund_observations")).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select * from payment_refund_events where action='provider_observed'",
        )
      ).rows.length,
      1,
    );
    const task = (
      await f.db.query<{ correction_status: string; cumulative: string }>(
        "select correction_status,cumulative_refunded_kopeks::text as cumulative from npd_receipt_tasks where id=$1",
        [f.source],
      )
    ).rows[0]!;
    assert.equal(task.correction_status, "required");
    assert.equal(task.cumulative, "2500");
  },
);

test(
  "PostgreSQL role and session revocation wins before refund creation and prevents any reservation",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      gate = paused(
        f.db,
        "select bootstrap_completed from account_security_state where id=1 for update",
      );
    const revoked = new AccountAccess(gate.db).setRole(
      f.first.userId,
      f.second.userId,
      "user",
    );
    await within(gate.entered.promise);
    const create = f.store.create(f.second, f.command());
    const denied = assert.rejects(
      create,
      (e) => e instanceof DomainError && [401, 403].includes(e.statusCode),
    );
    try {
      await waiting(f.db);
    } finally {
      gate.release.open();
    }
    await within(revoked);
    await within(denied);
    assert.equal(
      (await f.db.query("select * from payment_refunds")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("select * from credit_refund_allocations")).rows.length,
      0,
    );
    assert.equal((await f.ledger.status(f.buyer.userId)).heldMicros, 0);
  },
);

test(
  "PostgreSQL actual API grants post one verified refund and NPD duty, without financial identity/event rewrite or Worker access",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    // Fixed production-role names are deliberately used by the real grants
    // file, but only inside this newly created disposable loopback database.
    // The surrounding synthetic PostgreSQL owns these shared test roles.
    for (const name of [
      "citygo_api",
      "citygo_worker",
      "citygo_backup",
    ] as const) {
      const existing = await f.db.query(
        "select 1 from pg_roles where rolname=$1",
        [name],
      );
      if (!existing.rows.length) {
        try {
          await f.db.exec(
            `create role ${name} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
          );
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "42710"
          ))
            throw error;
        }
      }
      assert.deepEqual(
        (
          await f.db.query(
            "select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=$1",
            [name],
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
        "Runtime-role proof must not run with owner/superuser privileges",
      );
      await f.db.exec(`grant usage on schema public to ${name}`);
    }
    const grants = await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    );
    await f.db.exec(grants.replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, ""));
    const roleDb = (role: "citygo_api" | "citygo_worker"): Database => {
      const asRole = <T>(work: (tx: Sql) => Promise<T>) =>
        f.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          return work(tx);
        });
      return {
        ...f.db,
        transaction: asRole,
        query: <T>(sql: string, params?: unknown[]) =>
          asRole((tx) => tx.query<T>(sql, params)),
        exec: (sql) => asRole((tx) => tx.exec(sql)),
      };
    };
    const api = roleDb("citygo_api"),
      store = new PaymentRefunds(api);
    assert.equal(
      (await api.query<{ role: string }>("select current_user as role"))
        .rows[0]!.role,
      "citygo_api",
    );
    const command = f.command(),
      created = await store.create(f.first, command);
    assert.deepEqual(await store.create(f.first, command), created);
    const expected = { merchantId: "synthetic-shop", test: false };
    const prepared = await store.prepareDispatch(
      f.first,
      created.refund.id,
      expected,
    );
    assert.ok(prepared.dispatch);
    assert.equal(prepared.detail.refund.status, "unknown");
    const proof = f.proof(created.refund.id);
    await store.recordCreate(created.refund.id, prepared.dispatch.token, {
      ...proof,
      observation: "create_response",
      refundedAmountKopeks: 0,
    });
    assert.equal(
      (await new AiCreditLedger(api).status(f.buyer.userId)).heldMicros,
      25_000_000,
    );
    assert.equal(
      (await api.query("select 1 from npd_refund_observations")).rows.length,
      0,
    );
    const reconcile = await store.prepareReconcile(
      f.first,
      created.refund.id,
      expected,
    );
    assert.equal(reconcile.refundId, proof.id);
    const result = await store.recordObservation(created.refund.id, proof);
    assert.equal(result.refund.status, "succeeded");
    assert.deepEqual(
      await store.recordObservation(created.refund.id, proof),
      result,
    );
    const credit = await new AiCreditLedger(api).status(f.buyer.userId);
    assert.equal(credit.grantedMicros, 75_000_000);
    assert.equal(credit.heldMicros, 0);
    assert.equal(credit.availableMicros, 75_000_000);
    assert.equal(
      (
        await api.query(
          "select 1 from credit_refund_allocations where state='settled'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await api.query("select 1 from npd_refund_observations")).rows.length,
      1,
    );
    assert.deepEqual(
      (
        await api.query(
          "select correction_status,cumulative_refunded_kopeks::text as cumulative from npd_receipt_tasks where id=$1",
          [f.source],
        )
      ).rows,
      [{ correction_status: "required", cumulative: "2500" }],
    );
    const events = (
      await api.query("select * from payment_refund_events order by sequence")
    ).rows;
    for (const sql of [
      "update payment_refunds set amount_kopeks=2501,revision=revision+1",
      "update credit_source_lots set gross_micros=gross_micros+1",
      "update payment_refund_events set payload='{}'::jsonb",
      "delete from payment_refund_events",
      "delete from payment_refunds",
      "truncate table payment_refund_events",
    ])
      await assert.rejects(api.exec(sql), { code: "42501" });
    const worker = roleDb("citygo_worker");
    for (const table of [
      "payment_refunds",
      "payment_refund_events",
      "credit_source_lots",
      "credit_hold_allocations",
      "credit_refund_allocations",
      "npd_receipt_tasks",
      "npd_refund_observations",
    ])
      await assert.rejects(worker.query(`select * from ${table}`), {
        code: "42501",
      });
    assert.deepEqual(
      (await api.query("select * from payment_refund_events order by sequence"))
        .rows,
      events,
    );
    assert.deepEqual(
      await store.detailAdmin(f.first, result.refund.id),
      result,
    );
  },
);

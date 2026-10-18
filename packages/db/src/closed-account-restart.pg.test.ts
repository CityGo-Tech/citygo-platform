import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AiCreditLedger,
  ClosedAccountRestart,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type Sql,
} from "./index.js";
import {
  captureRestartRows,
  retainedFinancialTables,
  seedRestartFixture,
  seedRestartNpdObligation,
  seedRestartRefundHistory,
} from "./closed-account-restart-fixture.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires explicit disposable PostgreSQL; never use application database URLs",
  timeout: 60000,
};
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "An explicit disposable TEST_DATABASE_URL is required");
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  const name = "cg_restart_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_restart_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  const data = await seedRestartFixture(db);
  t.diagnostic("Isolated synthetic PostgreSQL database; no application data");
  return { db, data, restart: new ClosedAccountRestart(db) };
}
async function input(restart: ClosedAccountRestart) {
  return {
    expectedUserCount: 2,
    expectedSnapshotFingerprint: (
      await restart.plan({ expectedUserCount: 2, maintenanceConfirmed: true })
    ).snapshotFingerprint,
    backupReceiptSha256: "b".repeat(64),
    maintenanceConfirmed: true as const,
    servicesStoppedConfirmed: true as const,
    retainedAuditsReviewed: true as const,
    passwordHash: "synthetic-new-bootstrap-hash",
  };
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}
async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic PostgreSQL barrier timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function tagged(
  db: Database,
  name: string,
  gate?: {
    entered: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
    afterUserRows?: boolean;
  },
): Database {
  let paused = false;
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [name]);
        return work({
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (
              gate?.afterUserRows &&
              !paused &&
              /^select id from users order by id for update$/i.test(sql)
            ) {
              paused = true;
              gate.entered.open();
              await gate.release.promise;
            }
            return result;
          },
          exec: async (sql) => {
            await tx.exec(sql);
            if (
              gate &&
              !gate.afterUserRows &&
              !paused &&
              /lock\s+table\s+(?:public\.)?users\b/i.test(sql)
            ) {
              paused = true;
              gate.entered.open();
              await gate.release.promise;
            }
          },
        });
      }),
  };
}
async function waitForLock(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await db.query<{ blocked: boolean }>(
      `select exists (select 1 from pg_stat_activity w join pg_stat_activity h
        on h.pid=any(pg_blocking_pids(w.pid))
        where w.application_name=$1 and h.application_name=$2 and w.pid<>h.pid
          and w.wait_event_type='Lock') as blocked`,
      [waiter, holder],
    );
    if (result.rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Independent PostgreSQL backends must actually contend for a lock",
  );
}
function observe<T>(promise: Promise<T>) {
  void promise.catch(() => {});
  return promise;
}

test(
  "PostgreSQL closed restart preserves NPD receipt contact, corrections and delivery evidence unchanged",
  pgOnly,
  async (t) => {
    const { db, data, restart } = await fixture(t);
    await seedRestartNpdObligation(db, data.user, true);
    const retained = [...retainedFinancialTables, "ai_credit_topups"];
    const before = await captureRestartRows(db, retained);
    const plan = await restart.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.deepEqual(plan.blockers, []);
    assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-|@example\.test/);
    await restart.apply(await input(restart));
    assert.deepEqual(await captureRestartRows(db, retained), before);
  },
);

test(
  "PostgreSQL closed restart retains source allocations and canceled monetary refund events",
  pgOnly,
  async (t) => {
    const { db, data, restart } = await fixture(t);
    await seedRestartRefundHistory(db, data.user, { canceled: true });
    const before = await captureRestartRows(db, retainedFinancialTables);
    const plan = await restart.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.counts.credit_source_lots, 2);
    assert.equal(plan.counts.credit_hold_allocations, 1);
    assert.equal(plan.counts.credit_refund_allocations, 1);
    assert.equal(plan.counts.payment_refunds, 1);
    assert.equal(plan.counts.payment_refund_events, 2);
    await restart.apply(await input(restart));
    assert.deepEqual(
      await captureRestartRows(db, retainedFinancialTables),
      before,
    );
  },
);

test(
  "PostgreSQL closed restart preserves paid-attempt FK history and one-time bootstrap",
  pgOnly,
  async (t) => {
    const { db, data, restart } = await fixture(t);
    const before = await captureRestartRows(db, retainedFinancialTables);
    const result = await restart.apply(await input(restart));
    assert.equal(result.accountsRetired, 2);
    assert.equal(result.accountsDeleted, 0);
    assert.equal(result.accountingPreserved, true);
    assert.deepEqual(
      await captureRestartRows(db, retainedFinancialTables),
      before,
    );
    assert.equal(
      (
        await db.query(
          "select 1 from users where id=any($1::bigint[]) and status='deleted'",
          [data.ids],
        )
      ).rows.length,
      2,
    );
    assert.equal(
      (
        await db.query(
          "select 1 from user_credentials where user_id=any($1::bigint[])",
          [data.ids],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select 1 from users where username='admin' and role='super_admin' and must_change_password",
        )
      ).rows.length,
      1,
    );
    const after = await captureRestartRows(db);
    await assert.rejects(restart.apply(await input(restart)));
    assert.deepEqual(await captureRestartRows(db), after);
  },
);

test(
  "PostgreSQL reset table lock serializes a real registration and detects changed same-count snapshot",
  pgOnly,
  async (t) => {
    const { db, restart } = await fixture(t);
    const options = await input(restart);
    const gate = { entered: signal(), release: signal() };
    const prefix = "cgrestart_" + randomUUID().replaceAll("-", "");
    const reset = new ClosedAccountRestart(tagged(db, prefix + "_reset", gate));
    const repo = new Repository(tagged(db, prefix + "_register"));
    const one = observe(reset.apply(options));
    let two: Promise<string> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(
        repo.register(
          "queued-registration@example.test",
          "synthetic-queued-hash",
        ),
      );
      await waitForLock(db, prefix + "_register", prefix + "_reset");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    assert.ok(two);
    assert.equal((await one).accountsRetired, 2);
    const queued = await two;
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from users where id=$1",
          [queued],
        )
      ).rows[0]!.status,
      "active",
    );
    assert.equal(
      (await db.query("select 1 from users where username='admin'")).rows
        .length,
      1,
    );
    t.diagnostic(
      "A queued registration is not magically rejected by table locks: stopped services remain a required operator attestation",
    );
  },
);

test(
  "PostgreSQL registration committed before reset makes the pinned snapshot stale without partial erasure",
  pgOnly,
  async (t) => {
    const { db, restart } = await fixture(t);
    const options = await input(restart);
    const newUser = await new Repository(db).register(
      "before-reset@example.test",
      "synthetic-before-hash",
    );
    await db.query("delete from users where id=$1", [newUser]);
    // Same row count; changed original content still invalidates the snapshot.
    await db.query(
      "update messages set metadata=metadata || '{\"changed\":true}'::jsonb",
    );
    const before = await captureRestartRows(db);
    await assert.rejects(restart.apply(options));
    assert.deepEqual(await captureRestartRows(db), before);
  },
);

test(
  "PostgreSQL unresolved hold blocks reset while a real settlement waits for its locks",
  pgOnly,
  async (t) => {
    const { db, data, restart } = await fixture(t);
    const pending = randomUUID();
    await db.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'hold',1000)",
      [data.user, pending],
    );
    await db.query(
      "update ai_credit_accounts set held_micros=1000 where user_id=$1",
      [data.user],
    );
    // A new current-schema hold must carry the same source reservation as the
    // aggregate account. This case tests locking, not unresolved legacy drift.
    assert.equal(
      (
        await db.query(
          "update credit_source_lots set held_micros=held_micros+1000 where user_id=$1 and kind='gift' returning id",
          [data.user],
        )
      ).rows.length,
      1,
    );
    await db.query(
      "insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros) select $1,id,0,1000 from credit_source_lots where user_id=$2 and kind='gift'",
      [pending, data.user],
    );
    const options = await input(restart);
    const gate = { entered: signal(), release: signal(), afterUserRows: true };
    const prefix = "cgrestart_" + randomUUID().replaceAll("-", "");
    const resetting = new ClosedAccountRestart(
      tagged(db, prefix + "_reset", gate),
    );
    const ledger = new AiCreditLedger(tagged(db, prefix + "_settle"));
    const one = observe(resetting.apply(options));
    let two: ReturnType<typeof ledger.resolve> | undefined;
    try {
      await within(gate.entered.promise);
      two = observe(
        ledger.resolve(data.user, randomUUID(), pending, {
          kind: "settle",
          amountMicros: 500,
        }),
      );
      await waitForLock(db, prefix + "_settle", prefix + "_reset");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    assert.ok(two);
    await assert.rejects(one);
    await two;
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from users where id=$1",
          [data.user],
        )
      ).rows[0]!.status,
      "active",
    );
    assert.equal((await db.query("select 1 from messages")).rows.length, 1);
    assert.deepEqual(
      (
        await db.query(
          "select held_micros::text,spent_micros::text from ai_credit_accounts where user_id=$1",
          [data.user],
        )
      ).rows,
      [{ held_micros: "0", spent_micros: "120500" }],
    );
    assert.equal(
      (
        await db.query<{ bootstrap_completed: boolean }>(
          "select bootstrap_completed from account_security_state where id=1",
        )
      ).rows[0]!.bootstrap_completed,
      false,
    );
  },
);

test(
  "PostgreSQL deferred bootstrap trigger cannot mutate money at commit after final checks",
  pgOnly,
  async (t) => {
    const { db, restart } = await fixture(t);
    // Schema approval includes the trigger; rejection must come from the
    // post-write invariant after SET CONSTRAINTS, not from a stale fingerprint.
    await db.exec(`
      create function public.synthetic_restart_deferred_budget() returns trigger
      language plpgsql as $synthetic$
      begin
        if new.username='admin' then
          update public.ai_budget
            set total_reserved_micros=total_reserved_micros+1 where id=1;
        end if;
        return new;
      end
      $synthetic$;
      create constraint trigger synthetic_restart_deferred_budget
        after insert on public.users deferrable initially deferred
        for each row execute function public.synthetic_restart_deferred_budget();
    `);
    const options = await input(restart);
    const before = await captureRestartRows(db);
    await assert.rejects(restart.apply(options), {
      statusCode: 500,
      message: "Итоговый учёт изменился; транзакция отменена",
    });
    assert.deepEqual(await captureRestartRows(db), before);
  },
);

test(
  "PostgreSQL actual API and worker grants cannot execute closed-restart erasure",
  pgOnly,
  async (t) => {
    const { db, restart } = await fixture(t);
    const options = await input(restart);
    const before = await captureRestartRows(db);
    const suffix = randomUUID().replaceAll("-", "");
    const roles = {
      citygo_api: `cgr_api_${suffix}`,
      citygo_worker: `cgr_worker_${suffix}`,
      citygo_backup: `cgr_backup_${suffix}`,
    };
    const created: string[] = [];
    const failures: unknown[] = [];
    try {
      for (const role of Object.values(roles)) {
        assert.match(role, /^cgr_(api|worker|backup)_[a-f0-9]{32}$/);
        await db.exec(`create role ${role} nologin`);
        created.push(role);
        await db.exec(`grant usage on schema public to ${role}`);
      }
      const grants = (
        await readFile(
          new URL("../../../deploy/postgres/grants.sql", import.meta.url),
          "utf8",
        )
      )
        .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
        .replace(
          /\bcitygo_(api|worker|backup)\b/g,
          (name) => roles[name as keyof typeof roles],
        );
      await db.exec(grants);
      for (const role of [roles.citygo_api, roles.citygo_worker]) {
        const asRole = <T>(work: (tx: Sql) => Promise<T>) =>
          db.transaction(async (tx) => {
            await tx.exec(`set local role ${role}`);
            return work(tx);
          });
        const runtime: Database = {
          ...db,
          transaction: asRole,
          query: <T>(sql: string, params?: unknown[]) =>
            asRole((tx) => tx.query<T>(sql, params)),
          exec: (sql) => asRole((tx) => tx.exec(sql)),
        };
        await assert.rejects(runtime.query("delete from users where false"), {
          code: "42501",
        });
        await assert.rejects(
          runtime.query("delete from ai_credit_entries where false"),
          { code: "42501" },
        );
        await assert.rejects(new ClosedAccountRestart(runtime).apply(options));
        assert.deepEqual(await captureRestartRows(db), before);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      for (const role of created.reverse()) {
        try {
          await db.exec(`drop owned by ${role}; drop role ${role}`);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        assert.deepEqual(
          (
            await db.query(
              "select rolname from pg_roles where rolname=any($1::text[])",
              [created],
            )
          ).rows,
          [],
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Closed restart runtime grants or synthetic-role cleanup failed",
      );
  },
);

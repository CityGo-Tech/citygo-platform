import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AccountAccess,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type Sql,
} from "./index.js";
import { FreshAccountReset } from "./fresh-account-reset.js";
import {
  captureRestartRows,
  migrateLegacyRestartFixture,
  seedRestartNpdObligation,
  seedRestartFixture,
} from "./closed-account-restart-fixture.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires explicit disposable loopback PostgreSQL; never application database URLs",
  timeout: 60000,
};
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "An explicit disposable TEST_DATABASE_URL is required");
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Only loopback disposable test PostgreSQL is permitted",
  );
  assert.ok(
    ["/citygo_test", "/citygo_synthetic"].includes(url.pathname),
    "Only explicitly named test entry databases are permitted",
  );
  assert.equal(url.search, "");
  const name = "cg_fresh_reset_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_fresh_reset_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
      // Never drop an existing or user-selected database: only this freshly
      // generated name, after this test has confirmed successful CREATE.
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
  await migrateLegacyRestartFixture(db);
  const data = await seedRestartFixture(db);
  await db.exec(
    "update account_security_state set bootstrap_completed=true where id=1",
  );
  await db.exec(
    "update ai_budget set enabled=true,daily_limit_micros=1000000,user_daily_limit_micros=500000,rules='[{}]'::jsonb where id=1",
  );
  await db.exec(
    "insert into knowledge_sources(slug,title) values ('private-old','PRIVATE-KNOWLEDGE')",
  );
  await db.query(
    "insert into generated_artifacts(user_id,kind,storage_key) values ($1,'synthetic','PRIVATE-EXTERNAL-REFERENCE')",
    [data.user],
  );
  const operationId = randomUUID();
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'topup',100000000)",
    [data.user, operationId],
  );
  await db.query(
    "update ai_credit_accounts set granted_micros=granted_micros+100000000 where user_id=$1",
    [data.user],
  );
  await db.query(
    "insert into ai_credit_topups(provider_payment_id,operation_id,user_id,paid_kopeks,credited_micros,merchant_id,test,verified_at,verification_receipt) values ('synthetic-payment',$1,$2,10000,100000000,'synthetic-merchant',false,now(),'{\"private\":\"PRIVATE-PAYMENT\"}')",
    [operationId, data.user],
  );
  await migrate(db);
  t.diagnostic(
    "Independent synthetic PostgreSQL database, no working data or external requests",
  );
  return { db, data, reset: new FreshAccountReset(db) };
}
async function input(reset: FreshAccountReset, count = 2) {
  return {
    expectedUserCount: count,
    expectedSnapshotFingerprint: (
      await reset.plan({ expectedUserCount: count, maintenanceConfirmed: true })
    ).snapshotFingerprint,
    backupReceiptSha256: "b".repeat(64),
    maintenanceConfirmed: true as const,
    servicesStoppedConfirmed: true as const,
    destructiveResetConfirmed: true as const,
    passwordHash: "synthetic-bootstrap-hash",
  };
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function within<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Synthetic fresh-reset PostgreSQL barrier timed out"),
            ),
          milliseconds,
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
  },
): Database {
  let paused = false;
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [name]);
        return work({
          query: <T>(sql: string, params?: unknown[]) =>
            tx.query<T>(sql, params),
          exec: async (sql) => {
            await tx.exec(sql);
            if (gate && !paused && /^lock table public\.users /i.test(sql)) {
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
    const blocked = (
      await db.query<{ blocked: boolean }>(
        `select exists(select 1 from pg_stat_activity w join pg_stat_activity h
       on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2
       and w.pid<>h.pid and w.wait_event_type='Lock') as blocked`,
        [waiter, holder],
      )
    ).rows[0]!.blocked;
    if (blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Real independent PostgreSQL backends must contend for the reset lock",
  );
}
function observed<T>(promise: Promise<T>) {
  void promise.catch(() => {});
  return promise;
}

test(
  "PostgreSQL full reset refuses new NPD duties/evidence without deleting any retained row",
  pgOnly,
  async (t) => {
    const { db, data, reset } = await fixture(t);
    await seedRestartNpdObligation(db, data.user, true);
    const before = await captureRestartRows(db);
    const plan = await reset.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.ok(
      plan.blockers.some(
        (blocker) => blocker.code === "NPD_RECEIPT_HISTORY_PRESENT",
      ),
    );
    assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-|@example\.test/);
    await assert.rejects(reset.apply(await input(reset)), /заблокирован/);
    assert.deepEqual(await captureRestartRows(db), before);
  },
);

test(
  "PostgreSQL fresh reset truncates full FK-connected history/topups/knowledge and creates only closed first admin",
  pgOnly,
  async (t) => {
    const { db, data, reset } = await fixture(t);
    const retained = [
      "quests",
      "citygo_migrations",
      "citygo_migration_lock",
      "ai_routing",
    ];
    const before = await captureRestartRows(db, retained);
    const budget = (await db.query("select * from ai_budget")).rows[0]!;
    const receipt = await reset.apply(await input(reset));
    assert.equal(receipt.accountsDeleted, 2);
    assert.equal(receipt.accountingPreserved, false);
    assert.equal(receipt.publicIngressMayOpen, false);
    assert.equal(receipt.externalObjectsDeleted, false);
    assert.deepEqual(await captureRestartRows(db, retained), before);
    const plan = await reset.plan({
      expectedUserCount: 1,
      maintenanceConfirmed: true,
    });
    for (const name of plan.erasedTables.filter(
      (name) => !["users", "user_credentials", "audit_log"].includes(name),
    ))
      assert.equal(plan.counts[name], 0, name);
    assert.equal(plan.counts.users, 1);
    assert.equal(plan.counts.user_credentials, 1);
    assert.equal(plan.counts.audit_log, 1);
    const admin = await new AccountAccess(db).credentials("admin");
    assert.ok(admin);
    assert.equal(admin.role, "super_admin");
    assert.equal(admin.mustChangePassword, true);
    assert.equal(admin.password_hash, "synthetic-bootstrap-hash");
    assert.ok(BigInt(admin.id) > BigInt(data.ids[1]!));
    assert.equal(
      await new AccountAccess(db).credentials("restart-owner@example.test"),
      undefined,
    );
    assert.deepEqual((await db.query("select * from ai_budget")).rows[0], {
      ...budget,
      enabled: false,
      total_reserved_micros: "0",
      user_daily_limit_micros: null,
      revision: Number(budget.revision) + 1,
    });
    const after = await captureRestartRows(db);
    await assert.rejects(reset.apply(await input(reset, 1)), /заблокирован/);
    assert.deepEqual(await captureRestartRows(db), after);
  },
);

test(
  "PostgreSQL fresh reset rejects stale snapshot and rolls back TRUNCATE after deferred resurrection",
  pgOnly,
  async (t) => {
    const { db, reset } = await fixture(t);
    const stale = await input(reset);
    await db.exec("update knowledge_sources set title='PRIVATE-EDIT'");
    let before = await captureRestartRows(db);
    await assert.rejects(reset.apply(stale), /изменились/);
    assert.deepEqual(await captureRestartRows(db), before);
    await db.exec(`create function synthetic_fresh_deferred() returns trigger language plpgsql as $$ begin
      insert into knowledge_sources(slug,title) values ('resurrected','PRIVATE-RESURRECTED'); return new; end $$;
    create constraint trigger synthetic_fresh_deferred after insert on audit_log deferrable initially deferred
      for each row execute function synthetic_fresh_deferred()`);
    const pinned = await input(reset);
    before = await captureRestartRows(db);
    await assert.rejects(reset.apply(pinned), /История восстановлена/);
    assert.deepEqual(await captureRestartRows(db), before);
  },
);

test(
  "PostgreSQL fresh reset blocks actual registration; queued writes require the separate stopped-services gate",
  pgOnly,
  async (t) => {
    const { db, reset } = await fixture(t);
    const pinned = await input(reset);
    const prefix = "cgfresh_" + randomUUID().replaceAll("-", "");
    const gate = { entered: signal(), release: signal() };
    const resetting = new FreshAccountReset(
      tagged(db, prefix + "_reset", gate),
    );
    const registering = new Repository(tagged(db, prefix + "_register"));
    const one = observed(resetting.apply(pinned));
    let two: Promise<string> | undefined;
    try {
      await within(gate.entered.promise);
      two = observed(
        registering.register(
          "queued-new@example.test",
          "synthetic-queued-hash",
        ),
      );
      await waitForLock(db, prefix + "_register", prefix + "_reset");
    } finally {
      gate.release.open();
      await Promise.allSettled([one, ...(two ? [two] : [])]);
    }
    assert.equal((await one).accountsDeleted, 2);
    assert.ok(two);
    const newId = await two;
    assert.equal(
      (
        await db.query<{ status: string }>(
          "select status from users where id=$1",
          [newId],
        )
      ).rows[0]!.status,
      "active",
    );
    assert.equal(
      (
        await db.query(
          "select 1 from users where username='admin' and must_change_password",
        )
      ).rows.length,
      1,
    );
    t.diagnostic(
      "Table locks serialize writers, not shutdown them: ingress/API/Worker stop remains a mandatory operator attestation",
    );
  },
);

test(
  "PostgreSQL actual runtime API/Worker grants cannot perform destructive fresh reset or truncate accounting",
  pgOnly,
  async (t) => {
    const { db } = await fixture(t);
    const suffix = randomUUID().replaceAll("-", "");
    const roles = {
      citygo_api: `cgf_api_${suffix}`,
      citygo_worker: `cgf_worker_${suffix}`,
      citygo_backup: `cgf_backup_${suffix}`,
    };
    const created: string[] = [],
      failures: unknown[] = [];
    try {
      for (const role of Object.values(roles)) {
        assert.match(role, /^cgf_(api|worker|backup)_[a-f0-9]{32}$/);
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
      // The approved snapshot includes these real grants; refusal below cannot be
      // attributed merely to a changed ACL fingerprint.
      const reset = new FreshAccountReset(db),
        pinned = await input(reset);
      const before = await captureRestartRows(db);
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
        await assert.rejects(runtime.exec("truncate table ai_credit_topups"), {
          code: "42501",
        });
        await assert.rejects(runtime.query("delete from users where false"), {
          code: "42501",
        });
        await assert.rejects(new FreshAccountReset(runtime).apply(pinned));
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
        "Fresh-reset runtime grants or synthetic-role cleanup failed",
      );
  },
);

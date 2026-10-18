import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { AiExecution, AiBudgetInput } from "@citygo/contracts";
import { aiBudget, changeAiBudget, reserveAiMoney } from "./ai-budget.js";
import { DomainError } from "./errors.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires explicitly opted-in localhost disposable PostgreSQL; no PGlite race substitution",
  timeout: 60_000,
};
const execution: AiExecution = {
  key: "a".repeat(64),
  policy: {
    id: "b".repeat(64),
    version: "synthetic-budget-v1",
    provider: "routerai",
    model: "synthetic/router-model",
    recipient: "synthetic-recipient",
    routing: "synthetic-routing",
    data: "synthetic-data",
  },
  maxInputBytes: 1000,
  maxOutputTokens: 100,
};
const ceiling = 7;
const rule = { key: execution.key, attemptCeilingMicros: ceiling };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic budget barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const scoped = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(scoped.hostname));
  assert.equal(scoped.port, "55438");
  assert.equal(scoped.pathname, "/citygo_synthetic");
  assert.equal(scoped.search, "");
  assert.equal(scoped.hash, "");
  const name = "cg_budget_mode_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_budget_mode_[a-f0-9]{32}$/);
  // A new database is required: production migrations explicitly target public.
  // Never change search_path in, migrate or drop the supplied base database.
  const admin = await connectDatabase(base);
  const connections: Database[] = [];
  let created = false;
  t.after(async () => {
    const failures: unknown[] = [];
    for (const db of connections.reverse()) {
      try {
        await db.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (created) await admin.query(`drop database "${name}"`);
    } catch (error) {
      failures.push(error);
    } finally {
      await admin.close();
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic budget cleanup failed");
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  scoped.pathname = "/" + name;
  const connect = async () => {
    const db = await connectDatabase(scoped.toString());
    connections.push(db);
    return db;
  };
  const a = await connect(),
    b = await connect(),
    observer = await connect();
  await migrate(a);
  const repo = new Repository(a);
  const users = await Promise.all(
    ["first", "second"].map((user) =>
      repo.register(`${user}@synthetic-budget.example.test`, "SYNTHETIC-HASH"),
    ),
  );
  const providerInput = (revision: number): AiBudgetInput => ({
    expectedRevision: revision,
    enabled: true,
    mode: "routerai_balance",
    currency: "RUB",
    dailyLimitMicros: null,
    totalLimitMicros: null,
    rules: [rule],
  });
  const configure = (input: AiBudgetInput) =>
    changeAiBudget(a, users[0]!, input, [execution]);
  const status = () => aiBudget(observer, [execution]);
  return { a, b, observer, users, providerInput, configure, status };
}

// Stop connection A only after it has acquired the actual budget row lock.
// Connection B uses another account and another pool, so its observed lock wait
// is the budget singleton, not an unrelated per-account serialization lock.
async function race(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = deferred<void>(),
    release = deferred<void>(),
    bStarted = deferred<number>();
  let firstPid = 0;
  const reserve = async (db: Database, userId: string, first: boolean) =>
    db.transaction(async (tx) => {
      await tx.query("select id from users where id=$1 for update", [userId]);
      const pid = (
        await tx.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]!.pid;
      if (first) firstPid = pid;
      else bStarted.resolve(pid);
      const guarded: Sql = {
        ...tx,
        query: async <T>(sql: string, params?: unknown[]) => {
          const result = await tx.query<T>(sql, params);
          if (
            first &&
            sql === "select id from ai_budget where id=1 for update"
          ) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      };
      return reserveAiMoney(guarded, execution, userId);
    });
  const a = reserve(f.a, f.users[0]!, true).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let b: ReturnType<typeof reserve> | undefined;
  let bOutcome: Promise<Awaited<typeof a>> | undefined;
  try {
    await within(entered.promise);
    b = reserve(f.b, f.users[1]!, false);
    bOutcome = b.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const secondPid = await within(bStarted.promise);
    assert.notEqual(firstPid, secondPid);
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = (
        await f.observer.query(
          `select pid from pg_stat_activity where datname=current_database()
           and pid=$1 and wait_event_type='Lock'
           and query='select id from ai_budget where id=1 for update'`,
          [secondPid],
        )
      ).rows;
      if (rows.length) {
        blocked = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(
      blocked,
      true,
      "second PostgreSQL connection waited on the actual budget lock",
    );
  } finally {
    release.resolve();
    // Settle both operations before fixture cleanup, including barrier failures.
    await Promise.all([a, bOutcome]);
  }
  assert.ok(bOutcome);
  return { a: await within(a), b: await within(bOutcome) };
}

test(
  "PostgreSQL RouterAI mode serializes two independent reservations with null caps and unchanged ceiling/credit state",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const isolation = (
      await f.observer.query("select * from account_security_state")
    ).rows;
    await f.configure(f.providerInput(1));
    const aboveOldLimit = 1_000_000_000_001;
    await f.a.query("update ai_budget set total_reserved_micros=$1", [
      aboveOldLimit,
    ]);
    await f.a.query(
      "insert into ai_budget_daily(usage_day,reserved_micros) values((clock_timestamp() at time zone 'UTC')::date,$1)",
      [aboveOldLimit],
    );
    const result = await race(f);
    assert.equal(result.a.ok, true);
    assert.equal(result.b.ok, true);
    for (const item of [result.a, result.b]) {
      assert.ok(item.ok);
      assert.equal(item.value.amountMicros, ceiling);
      assert.equal(item.value.currency, "RUB");
      assert.equal(item.value.ruleKey, execution.key);
      assert.equal(item.value.revision, 2);
    }
    const status = await f.status();
    assert.equal(status.settings.mode, "routerai_balance");
    assert.equal(status.settings.dailyLimitMicros, null);
    assert.equal(status.settings.totalLimitMicros, null);
    assert.equal(status.settings.userDailyLimitMicros, null);
    assert.equal(status.settings.rules[0]!.attemptCeilingMicros, ceiling);
    assert.equal(status.totalReservedMicros, aboveOldLimit + ceiling * 2);
    assert.equal(status.reservedTodayMicros, aboveOldLimit + ceiling * 2);
    assert.deepEqual(
      (await f.observer.query("select * from account_security_state")).rows,
      isolation,
    );
    for (const table of [
      "ai_credit_accounts",
      "ai_credit_entries",
      "ai_credit_charges",
      "ai_credit_topups",
    ])
      assert.equal(
        (await f.observer.query(`select 1 from ${table}`)).rows.length,
        0,
      );
  },
);

test(
  "PostgreSQL RouterAI mode fails closed at the safe-integer boundary without partial or rounded counters",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    await f.configure(f.providerInput(1));
    await f.a.query("update ai_budget set total_reserved_micros=$1", [
      Number.MAX_SAFE_INTEGER - ceiling,
    ]);
    await f.a.query(
      "insert into ai_budget_daily(usage_day,reserved_micros) values((clock_timestamp() at time zone 'UTC')::date,$1)",
      [Number.MAX_SAFE_INTEGER - ceiling],
    );
    const result = await race(f);
    assert.equal(result.a.ok, true);
    assert.equal(result.b.ok, false);
    assert.ok(!result.b.ok && result.b.error instanceof DomainError);
    assert.equal(result.b.error.statusCode, 429);
    const status = await f.status();
    assert.equal(status.totalReservedMicros, Number.MAX_SAFE_INTEGER);
    assert.equal(status.reservedTodayMicros, Number.MAX_SAFE_INTEGER);
    assert.equal(status.settings.totalLimitMicros, null);
    assert.equal(status.settings.dailyLimitMicros, null);
    for (const sql of [
      "update ai_budget set total_reserved_micros=9007199254740992",
      "update ai_budget_daily set reserved_micros=9007199254740992",
    ])
      await assert.rejects(
        f.a.query(sql),
        (error) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23514",
      );
  },
);

test(
  "PostgreSQL mode switch preserves a personal stop unless explicitly cleared and never enables user credit",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    await f.configure({
      expectedRevision: 1,
      enabled: false,
      currency: "RUB",
      dailyLimitMicros: 100,
      totalLimitMicros: 100,
      userDailyLimitMicros: 0,
      rules: [rule],
    });
    await f.configure(f.providerInput(2));
    assert.equal((await f.status()).settings.userDailyLimitMicros, 0);
    await assert.rejects(
      f.a.transaction((tx) => reserveAiMoney(tx, execution, f.users[0]!)),
      (error) => error instanceof DomainError && error.statusCode === 429,
    );
    assert.equal((await f.status()).totalReservedMicros, 0);
    await f.configure({ ...f.providerInput(3), userDailyLimitMicros: null });
    await f.a.transaction((tx) => reserveAiMoney(tx, execution, f.users[0]!));
    assert.equal((await f.status()).totalReservedMicros, ceiling);
    assert.equal((await f.status()).settings.userDailyLimitMicros, null);
    assert.equal(
      (await f.observer.query("select 1 from ai_credit_accounts")).rows.length,
      0,
    );
  },
);

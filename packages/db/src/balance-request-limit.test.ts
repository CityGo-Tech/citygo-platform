import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  CITYGO_10X_TARIFF,
  agentKeys,
  routerAiCostMicros,
  type AiExecution,
} from "@citygo/contracts";
import { AiCreditCharges } from "./ai-credit-charges.js";
import { AiCreditLedger } from "./ai-credit.js";
import { changeAiBudget } from "./ai-budget.js";
import type { AiRequestCostLimitMode } from "./request-cost-limit.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "./index.js";

import {
  reservePaidRefund,
  releasePaidRefund,
  listPaidSourceLots,
} from "./credit-source-lots.js";

const RUB = 1_000_000;
const execution: AiExecution = {
  key: "a".repeat(64),
  policy: {
    id: "b".repeat(64),
    version: "synthetic-balance-v1",
    provider: "routerai",
    model: "synthetic/model",
    recipient: "synthetic",
    routing: "synthetic",
    data: "synthetic",
  },
  maxInputBytes: 1000,
  maxOutputTokens: 100,
};
async function fixture(
  t: TestContext,
  mode: AiRequestCostLimitMode = "user_balance",
  schema44 = false,
  runtimeRole = false,
) {
  const base = process.env.TEST_DATABASE_URL;
  const name = "balance_limit_test_" + randomUUID().replaceAll("-", "");
  let admin: Database | undefined,
    created = false;
  const peers: Database[] = [];
  const createdRoles: string[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [
      ...peers.map((db) => () => db.close()),
      async () => {
        if (created) await admin!.query(`drop database "${name}"`);
      },
      ...createdRoles.map((role) => async () => {
        await admin!.query(`drop role "${role}"`);
      }),
      async () => admin?.close(),
    ])
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Synthetic balance limit cleanup failed",
      );
  });
  let url = "pglite://:memory:";
  if (base) {
    const target = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
    assert.ok(
      ((target.port || "5432") === "5432" &&
        target.pathname === "/citygo_test") ||
        (target.port === "55438" && target.pathname === "/citygo_synthetic"),
    );
    assert.equal(target.search, "");
    assert.equal(target.hash, "");
    admin = await connectDatabase(base);
    await admin.query(`create database "${name}" template template0`);
    created = true;
    target.pathname = "/" + name;
    url = target.toString();
  }
  const db = await connectDatabase(url);
  peers.push(db);
  if (runtimeRole) {
    assert.ok(
      base,
      "Restricted-role evidence requires the disposable PostgreSQL target",
    );
    const roles = [
      "citygo_api",
      "citygo_worker",
      "citygo_backup",
      "citygo_migrator",
    ];
    assert.equal(
      (
        await db.query(
          "select rolname from pg_roles where rolname=any($1::text[])",
          [roles],
        )
      ).rows.length,
      0,
      "Never alter an existing cluster role",
    );
    for (const role of roles) {
      await db.exec(
        `create role "${role}" ${role === "citygo_api" ? "login password 'synthetic-balance-api-password'" : "nologin"} nosuperuser nocreatedb nocreaterole`,
      );
      createdRoles.push(role);
    }
    await db.exec(
      `revoke all on schema public from public;grant usage,create on schema public to citygo_migrator;grant create on database "${name}" to citygo_migrator;grant usage on schema public to citygo_api,citygo_worker,citygo_backup;alter default privileges for role citygo_migrator revoke execute on functions from public;set role citygo_migrator`,
    );
  }
  if (schema44) {
    await db.exec(
      "create table citygo_migration_lock(id integer primary key);insert into citygo_migration_lock values(1);create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
    );
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .slice(0, 44)) {
      const sql = await readFile(new URL(file, dir), "utf8");
      await db.transaction(async (tx) => {
        await tx.exec(
          sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
        );
        await tx.query(
          "insert into citygo_migrations(name,checksum,applied_at) values($1,$2,'2026-11-02T00:00:00Z')",
          [
            file,
            createHash("sha256")
              .update(sql.replaceAll("\r\n", "\n"))
              .digest("hex"),
          ],
        );
      });
    }
  } else await migrate(db);
  if (runtimeRole) {
    const grants = (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    ).replace(/^\\set[^\n]*\n/gm, "");
    await db.exec(grants);
    await db.exec("reset role");
  }
  let runtimeApi: Database | undefined;
  if (runtimeRole) {
    const scoped = new URL(url);
    scoped.username = "citygo_api";
    scoped.password = "synthetic-balance-api-password";
    runtimeApi = await connectDatabase(scoped.toString());
    peers.push(runtimeApi);
  }
  const user = await new Repository(db).register(
    "balance-limit@example.test",
    "SYNTHETIC-HASH",
  );
  const other = await new Repository(db).register(
    "other-balance@example.test",
    "SYNTHETIC-HASH",
  );
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  const charges = new AiCreditCharges(
    db,
    CITYGO_10X_TARIFF,
    "fixed5_overdraft",
    mode,
  );
  const repo = (using = db) =>
    new Repository(
      using,
      true,
      CITYGO_10X_TARIFF,
      false,
      "fixed5_overdraft",
      false,
      undefined,
      mode,
    );
  async function topup(kopeks = 10_000) {
    const operation = randomUUID();
    await ledger.topUpConfirmed(user, operation, {
      providerPaymentId: randomUUID(),
      paidKopeks: kopeks,
      merchantId: "synthetic",
      test: false,
      verifiedAt: "2026-11-02T00:00:00Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    return operation;
  }
  if (!schema44)
    await changeAiBudget(
      db,
      user,
      {
        expectedRevision: 1,
        enabled: true,
        mode: "routerai_balance",
        currency: "RUB",
        dailyLimitMicros: null,
        totalLimitMicros: null,
        userDailyLimitMicros: null,
        rules: [{ key: execution.key, attemptCeilingMicros: 6 * RUB }],
      },
      [execution],
    );
  let requestIndex = 0;
  async function request() {
    const assistant = agentKeys[requestIndex++];
    assert.ok(
      assistant,
      "Synthetic fixture exhausted distinct open assistant conversations",
    );
    const lease = randomUUID();
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,conversation_agent_key,lease_token,busy_until) values($1,$3,$3,$2,clock_timestamp()+interval '10 minutes') returning id::text",
        [user, lease, assistant],
      )
    ).rows[0]!.id;
    const requestId = randomUUID();
    await db.query(
      "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'running',$3,1)",
      [thread, requestId, execution.policy.id],
    );
    return {
      userId: user,
      threadId: thread,
      requestId,
      lease,
      attemptNumber: 1,
      provider: "routerai" as const,
      model: execution.policy.model,
      policyId: execution.policy.id,
      routingRevision: 1,
      userDailyLimit: 100,
      globalDailyLimit: 1000,
      execution,
      upstream: "synthetic",
    };
  }
  async function reserve() {
    const input = await request();
    const hold = await repo().reserveAiAttempt(input);
    assert.ok(hold);
    return { hold, input };
  }
  async function receipt(hold: string, costRub: string) {
    const generationId = "synthetic-" + randomUUID();
    await charges.dispatch(user, hold);
    await charges.identify(user, hold, generationId);
    await db.query(
      "update ai_credit_charges set response_complete=true where hold_id=$1",
      [hold],
    );
    return {
      generationId,
      reference: hold,
      model: execution.policy.model,
      upstream: "synthetic",
      currency: "RUB" as const,
      costRub,
      amountMicros: routerAiCostMicros(costRub),
    };
  }
  const budget = async () =>
    (
      await db.query<{ enabled: boolean; revision: number }>(
        "select enabled,revision from ai_budget where id=1",
      )
    ).rows[0]!;
  return {
    db,
    runtimeApi,
    user,
    other,
    ledger,
    charges,
    repo,
    topup,
    request,
    reserve,
    receipt,
    budget,
    async peer() {
      assert.ok(base, "Requires opt-in disposable PostgreSQL");
      const peer = await connectDatabase(url);
      peers.push(peer);
      return peer;
    },
  };
}

test("user-balance request admission captures exact pre-hold balance and replaces only the new attempt's six-real-RUB limit", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const { hold } = await f.reserve();
  const charge = await f.charges.get(f.user, hold);
  assert.equal(charge.cost_limit_mode, "user_balance");
  assert.equal(String(charge.balance_before_hold_micros), "100000000");
  assert.equal(String(charge.real_ceiling_micros), "10000000");
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  assert.equal(
    (
      await f.db.query<{ amount: string }>(
        "select money_reserved_micros::text as amount from ai_model_attempts where user_id=$1",
        [f.user],
      )
    ).rows[0]!.amount,
    "10000000",
  );
  assert.equal(
    (
      await f.db.query<{ rules: { attemptCeilingMicros: number }[] }>(
        "select rules from ai_budget",
      )
    ).rows[0]!.rules[0]!.attemptCeilingMicros,
    6 * RUB,
    "The original operator approval is never rewritten into a balance",
  );
  await f.topup(5000);
  assert.equal(
    String((await f.charges.get(f.user, hold)).balance_before_hold_micros),
    "100000000",
    "A later top-up cannot enlarge an accepted attempt",
  );
  await assert.rejects(
    f.db.query(
      "update ai_credit_charges set balance_before_hold_micros=150000000,real_ceiling_micros=15000000 where hold_id=$1",
      [hold],
    ),
    /immutable/i,
  );
});

test("above-cap known cost is debited exactly ×10 once, carries a negative beyond legacy55 and never disables the operator budget", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const { hold } = await f.reserve();
  const raw = await f.receipt(hold, "20.000000123");
  const before = await f.budget();
  await f.charges.settle(f.user, hold, raw);
  const balance = await f.ledger.status(f.user);
  assert.equal(balance.spentMicros, 200_000_001);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.availableMicros, -100_000_001);
  assert.equal(balance.outstandingDebtMicros, 100_000_001);
  assert.deepEqual(await f.budget(), before);
  assert.equal(
    (
      await f.db.query(
        "select id from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    1,
  );
  const snapshots = JSON.stringify(
    (
      await f.db.query(
        "select kind,amount_micros::text from ai_credit_entries where user_id=$1 order by id",
        [f.user],
      )
    ).rows,
  );
  await new AiCreditCharges(f.db, CITYGO_10X_TARIFF, "fixed5_overdraft").settle(
    f.user,
    hold,
    raw,
  );
  assert.equal(
    JSON.stringify(
      (
        await f.db.query(
          "select kind,amount_micros::text from ai_credit_entries where user_id=$1 order by id",
          [f.user],
        )
      ).rows,
    ),
    snapshots,
    "Replay uses the row's accepted mode even after current config changes",
  );
  assert.equal(
    (
      await f.db.query(
        "select id from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    1,
  );
  await assert.rejects(
    f.charges.settle(f.user, hold, {
      ...raw,
      costRub: "20.0000002",
      amountMicros: routerAiCostMicros("20.0000002"),
    }),
    /стоимость изменилась/,
  );
  await f.topup(20_000);
  const repaid = await f.ledger.status(f.user);
  assert.equal(repaid.outstandingDebtMicros, 0);
  assert.equal(repaid.availableMicros, 99_999_999);
});

test("fractional provider prices floor only after ×10 and the following limit snapshots the remaining CityGo micros before its hold", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const first = await f.reserve();
  await f.charges.settle(
    f.user,
    first.hold,
    await f.receipt(first.hold, "0.123456789"),
  );
  assert.equal((await f.ledger.status(f.user)).availableMicros, 98_765_433);
  const second = await f.reserve();
  const charge = await f.charges.get(f.user, second.hold);
  assert.equal(String(charge.balance_before_hold_micros), "98765433");
  assert.equal(String(charge.real_ceiling_micros), "9876543");
});

test("an exact decimal just above the accepted cap settles automatically even if final rounded debit still equals the original balance", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const { hold } = await f.reserve();
  await f.charges.settle(
    f.user,
    hold,
    await f.receipt(hold, "10.000000000001"),
  );
  assert.equal((await f.ledger.status(f.user)).availableMicros, 0);
  assert.equal((await f.budget()).enabled, true);
  assert.equal(
    (
      await f.db.query(
        "select id from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    1,
  );
});

test("unknown, malformed or wrong-owner receipts never invent zero or dispatch another attempt", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const { hold } = await f.reserve();
  await assert.rejects(
    f.charges.settle(f.user, hold, {
      generationId: "unknown",
      reference: hold,
      model: execution.policy.model,
      upstream: "synthetic",
      currency: "RUB",
      costRub: "1",
      amountMicros: RUB,
    }),
    /завершённой попытке/,
  );
  const raw = await f.receipt(hold, "1");
  await assert.rejects(f.charges.settle(f.other, hold, raw), /не найден/);
  await assert.rejects(
    f.charges.settle(f.user, hold, { ...raw, amountMicros: 0 }),
  );
  const next = await f.request();
  const before = (
    await f.db.query("select reserved_attempts from ai_model_attempt_daily")
  ).rows;
  await assert.rejects(
    f.repo().reserveAiAttempt(next),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AI_CREDIT_UNAVAILABLE",
  );
  assert.deepEqual(
    (await f.db.query("select reserved_attempts from ai_model_attempt_daily"))
      .rows,
    before,
  );
  const balance = await f.ledger.status(f.user);
  assert.equal(balance.heldMicros, 5 * RUB);
  assert.equal(balance.spentMicros, 0);
  assert.equal((await f.budget()).enabled, true);
});

test("legacy charges keep their original six-RUB/manual-overrun semantics after the new migration and even under a new current admission config", async (t) => {
  const f = await fixture(t, "operator_ceiling");
  await f.topup();
  const { hold } = await f.reserve();
  const charge = await f.charges.get(f.user, hold);
  assert.equal(charge.cost_limit_mode, "operator_ceiling");
  assert.equal(charge.balance_before_hold_micros, null);
  assert.equal(String(charge.real_ceiling_micros), "6000000");
  const raw = await f.receipt(hold, "6.00000000001");
  await assert.rejects(
    new AiCreditCharges(
      f.db,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
      "user_balance",
    ).settle(f.user, hold, raw),
    /администратором/,
  );
  assert.equal((await f.budget()).enabled, false);
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 0);
  await assert.rejects(
    f.db.query(
      "update ai_credit_charges set cost_limit_mode='user_balance',balance_before_hold_micros=60000000 where hold_id=$1",
      [hold],
    ),
    /immutable/,
  );
});

test("balance admission rejects less than five CityGo without persisting attempt or monetary counters", async (t) => {
  const f = await fixture(t);
  await f.topup(499);
  const input = await f.request();
  await assert.rejects(
    f.repo().reserveAiAttempt(input),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AI_CREDIT_EXHAUSTED",
  );
  assert.equal(
    (await f.db.query("select * from ai_model_attempts")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select * from ai_budget_daily")).rows.length,
    0,
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
});

test("an attempted charge limit cannot exceed its locked balance and raw SQL cannot forge the admission snapshot", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const input = await f.request();
  await f.db.query(
    "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key)values($1,$2,1,$3,'routerai',$4,$5,1,'RUB',11000000,1,$5)",
    [
      input.threadId,
      input.requestId,
      f.user,
      execution.policy.model,
      execution.policy.id,
    ],
  );
  await assert.rejects(
    f.db.transaction((tx) => f.charges.reserve(tx, input, 11 * RUB)),
    /не соответствует/,
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
  await assert.rejects(
    f.db.transaction(async (tx) => {
      const hold = randomUUID();
      await f.ledger.hold(f.user, hold, 5 * RUB, tx);
      await tx.query(
        "insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,tariff_snapshot,real_ceiling_micros,reservation_mode,cost_limit_mode,balance_before_hold_micros)values($1,$2,$3,$4,1,$5,'synthetic',$6,11000000,'fixed5_overdraft','user_balance',110000000)",
        [
          hold,
          f.user,
          input.threadId,
          input.requestId,
          execution.policy.model,
          JSON.stringify(CITYGO_10X_TARIFF),
        ],
      );
    }),
    /pre-hold/,
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
});

test("44→45 preserves every historical charge/receipt/ledger row, all44 migration receipts and function ACLs without enabling the new mode", async (t) => {
  const f = await fixture(t, "operator_ceiling", true);
  await f.topup();
  const input = await f.request();
  const hold = randomUUID();
  await f.db.query(
    "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key)values($1,$2,1,$3,'routerai',$4,$5,1,'RUB',6000000,1,$5)",
    [
      input.threadId,
      input.requestId,
      f.user,
      execution.policy.model,
      execution.policy.id,
    ],
  );
  await f.ledger.hold(f.user, hold, 5 * RUB);
  await f.db.query(
    "insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,tariff_snapshot,real_ceiling_micros,reservation_mode)values($1,$2,$3,$4,1,$5,'synthetic',$6,6000000,'fixed5_overdraft')",
    [
      hold,
      f.user,
      input.threadId,
      input.requestId,
      execution.policy.model,
      JSON.stringify(CITYGO_10X_TARIFF),
    ],
  );
  const snapshot = async (upgraded = false) => ({
    charges: (
      await f.db.query(
        `select ${upgraded ? "to_jsonb(c)-'cost_limit_mode'-'balance_before_hold_micros'" : "to_jsonb(c)"} as value from ai_credit_charges c order by hold_id`,
      )
    ).rows,
    entries: (
      await f.db.query(
        "select to_jsonb(e) as value from ai_credit_entries e order by id",
      )
    ).rows,
    accounts: (
      await f.db.query(
        "select to_jsonb(a) as value from ai_credit_accounts a order by user_id",
      )
    ).rows,
    budget: (await f.db.query("select to_jsonb(b) as value from ai_budget b"))
      .rows,
    acls: (
      await f.db.query(
        "select proname,pg_get_userbyid(proowner)as owner,prosecdef,proacl::text from pg_proc where proname in('citygo_guard_charge_reservation_mode','citygo_guard_credit_debt_identity','citygo_check_credit_debt_conservation') order by proname",
      )
    ).rows,
  });
  const before = await snapshot();
  const oldJournal = (
    await f.db.query("select * from citygo_migrations order by name")
  ).rows;
  assert.equal(oldJournal.length, 44);
  await migrate(f.db);
  assert.deepEqual(await snapshot(true), before);
  assert.deepEqual(
    (
      await f.db.query("select * from citygo_migrations order by name")
    ).rows.slice(0, 44),
    oldJournal,
  );
  assert.equal(
    (await f.charges.get(f.user, hold)).cost_limit_mode,
    "operator_ceiling",
  );
  assert.equal(
    (
      await f.db.query(
        "select name from citygo_migrations where name='0045_ai_balance_request_cost_limit.sql'",
      )
    ).rows.length,
    1,
  );
});

test(
  "real PostgreSQL observes two-connection lock waits and commits one admission/one over-cap settlement",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.topup();
    const peer = await f.peer();
    const inputs = await Promise.all([f.request(), f.request()]);
    function barrier() {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
          enter = r;
        }),
        released = new Promise<void>((r) => {
          release = r;
        });
      let paused = false;
      const db: Database = {
        ...f.db,
        transaction: (work) =>
          f.db.transaction((tx) =>
            work({
              ...tx,
              query: async <T>(sql: string, params?: unknown[]) => {
                const result = await tx.query<T>(sql, params);
                if (
                  !paused &&
                  sql.startsWith("select id from users where id=$1 for update")
                ) {
                  paused = true;
                  enter();
                  await released;
                }
                return result;
              },
            }),
          ),
      };
      return { db, entered, release };
    }
    async function within<T>(value: Promise<T>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          value,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Synthetic PostgreSQL barrier timeout")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    async function locked() {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if (
          (
            await f.db.query(
              "select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'",
            )
          ).rows.length
        )
          return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    }
    const admission = barrier();
    const first = f.repo(admission.db).reserveAiAttempt(inputs[0]!);
    const observedFirst = first.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    let second: Promise<string | null> | undefined,
      observedSecond: Promise<unknown> | undefined,
      waited = false;
    try {
      await within(admission.entered);
      second = f.repo(peer).reserveAiAttempt(inputs[1]!);
      observedSecond = second.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      waited = await locked();
    } finally {
      admission.release();
    }
    const result = await within(observedFirst);
    await within(observedSecond!);
    assert.equal(
      waited,
      true,
      "Observe an actual PostgreSQL lock wait, not a Promise scheduling substitute",
    );
    assert.equal(result.status, "fulfilled");
    await assert.rejects(
      second!,
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "AI_CREDIT_UNAVAILABLE",
    );
    assert.equal(
      (await f.db.query("select * from ai_model_attempts")).rows.length,
      1,
    );
    assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
    assert.equal(result.status, "fulfilled");
    if (result.status !== "fulfilled")
      throw new Error("Admission did not complete");
    const hold = result.value!;
    const raw = await f.receipt(hold, "20.000000123");
    const settlement = barrier();
    const settling = new AiCreditCharges(
      settlement.db,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
      "user_balance",
    ).settle(f.user, hold, raw);
    let replay: Promise<void> | undefined,
      replayObserved: Promise<unknown> | undefined,
      settlementWait = false;
    const settledObserved = settling.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      await within(settlement.entered);
      replay = new AiCreditCharges(
        peer,
        CITYGO_10X_TARIFF,
        "fixed5_overdraft",
        "user_balance",
      ).settle(f.user, hold, raw);
      replayObserved = replay.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      settlementWait = await locked();
    } finally {
      settlement.release();
    }
    await within(Promise.all([settledObserved, replayObserved]));
    await settling;
    await replay;
    assert.equal(settlementWait, true);
    assert.equal(
      (
        await f.db.query("select * from ai_credit_entries where hold_id=$1", [
          hold,
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select * from audit_log where action='ai-credit-balance-limit-exceeded'",
        )
      ).rows.length,
      1,
    );
    assert.equal((await f.ledger.status(f.user)).spentMicros, 200_000_001);
    assert.equal((await f.budget()).enabled, true);
  },
);

test("balance cap excludes a protected refund; an over-cap receipt cannot consume that source until refund cancellation repays the exact debt", async (t) => {
  const f = await fixture(t);
  const paid = await f.topup();
  const refund = randomUUID();
  await f.db.transaction(async (tx) => {
    await tx.query("select id from users where id=$1 for update", [f.user]);
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [f.user],
    );
    await reservePaidRefund(tx, f.user, paid, refund, 5000);
  });
  const { hold } = await f.reserve();
  assert.equal(
    String((await f.charges.get(f.user, hold)).balance_before_hold_micros),
    "50000000",
  );
  assert.equal(
    String((await f.charges.get(f.user, hold)).real_ceiling_micros),
    "5000000",
  );
  await f.charges.settle(f.user, hold, await f.receipt(hold, "6"));
  let balance = await f.ledger.status(f.user);
  assert.equal(balance.outstandingDebtMicros, 10 * RUB);
  assert.equal(balance.heldMicros, 50 * RUB);
  assert.equal((await f.budget()).enabled, true);
  await f.db.transaction(async (tx) => {
    await tx.query("select id from users where id=$1 for update", [f.user]);
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [f.user],
    );
    await releasePaidRefund(tx, f.user, refund);
  });
  balance = await f.ledger.status(f.user);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.availableMicros, 40 * RUB);
  assert.equal(
    (await listPaidSourceLots(f.db, f.user))[0]!.availableMicros,
    40 * RUB,
  );
});

test("audit, exact receipt, debt, sources and settlement roll back atomically if durable receipt persistence fails", async (t) => {
  const f = await fixture(t);
  await f.topup();
  const { hold } = await f.reserve();
  const raw = await f.receipt(hold, "20");
  const failing: Database = {
    ...f.db,
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            if (sql.startsWith("update ai_credit_charges set receipt"))
              throw new Error("Synthetic receipt persistence failure");
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new AiCreditCharges(
      failing,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
      "user_balance",
    ).settle(f.user, hold, raw),
    /Synthetic receipt/,
  );
  assert.equal((await f.charges.get(f.user, hold)).receipt, null);
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 0);
  assert.equal(
    (await f.db.query("select * from credit_charge_debts")).rows.length,
    0,
  );
  assert.equal(
    (
      await f.db.query(
        "select * from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    0,
  );
  await f.charges.settle(f.user, hold, raw);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 200 * RUB);
  assert.equal(
    (
      await f.db.query(
        "select * from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    1,
  );
});

test(
  "real PostgreSQL citygo_api role can reserve and auto-settle balance-marked charges with existing narrow grants and no PUBLIC/worker privilege expansion",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, "user_balance", false, true);
    await f.topup();
    const api = f.runtimeApi!;
    assert.deepEqual(
      (await api.query("select current_user::text as role")).rows,
      [{ role: "citygo_api" }],
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname='citygo_api'",
        )
      ).rows,
      [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }],
    );
    const input = await f.request();
    const hold = (await f.repo(api).reserveAiAttempt(input))!;
    const charges = new AiCreditCharges(
      api,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
      "user_balance",
    );
    const generationId = "synthetic-" + randomUUID();
    await charges.dispatch(f.user, hold);
    await charges.identify(f.user, hold, generationId);
    await api.query(
      "update ai_credit_charges set response_complete=true where hold_id=$1",
      [hold],
    );
    const raw = {
      generationId,
      reference: hold,
      model: execution.policy.model,
      upstream: "synthetic",
      currency: "RUB" as const,
      costRub: "20.000000123",
      amountMicros: 20 * RUB,
    };
    await charges.settle(f.user, hold, raw);
    assert.equal(
      (
        await new AiCreditLedger(
          api,
          "routerai_citygo_10x",
          false,
          "fixed5_overdraft",
        ).status(f.user)
      ).availableMicros,
      -100_000_001,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select has_table_privilege('citygo_worker','ai_credit_charges','SELECT') as worker,has_function_privilege('citygo_worker','citygo_apply_credit_debt_repayments(bigint)','EXECUTE') as worker_execute,has_function_privilege('citygo_api','citygo_apply_credit_debt_repayments(bigint)','EXECUTE') as api_execute",
        )
      ).rows,
      [{ worker: false, worker_execute: false, api_execute: true }],
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select p.prosecdef,pg_get_userbyid(p.proowner) as owner from pg_proc p where p.oid='citygo_apply_credit_debt_repayments(bigint)'::regprocedure",
        )
      ).rows,
      [{ prosecdef: false, owner: "citygo_migrator" }],
    );
  },
);

test("an extreme valid provider receipt beyond remaining finite journal capacity stays pending atomically instead of posting unreadable counters", async (t) => {
  const f = await fixture(t);
  await f.topup(1_000_000_000);
  const first = await f.reserve();
  await f.charges.settle(
    f.user,
    first.hold,
    await f.receipt(first.hold, "0.1"),
  );
  const second = await f.reserve();
  const raw = await f.receipt(second.hold, "1000000");
  await assert.rejects(
    f.charges.settle(f.user, second.hold, raw),
    /технический предел/,
  );
  assert.equal((await f.charges.get(f.user, second.hold)).receipt, null);
  assert.equal((await f.ledger.status(f.user)).spentMicros, RUB);
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  assert.equal((await f.budget()).enabled, true);
  assert.equal(
    (
      await f.db.query(
        "select * from audit_log where action='ai-credit-balance-limit-exceeded'",
      )
    ).rows.length,
    0,
  );
});

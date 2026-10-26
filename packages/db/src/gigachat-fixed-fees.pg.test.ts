import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { CITYGO_10X_TARIFF, type AiPolicy } from "@citygo/contracts";
import {
  AiCreditLedger,
  DomainError,
  GigaChatFixedFees,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type AiRequestModeSnapshot,
} from "./index.js";
const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in disposable PostgreSQL; PGlite is not lock evidence",
  timeout: 60000,
};
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
const common: AiPolicy = {
  id: h("pg-giga-common"),
  provider: "routerai",
  model: "citygo-bundle",
  version: "synthetic-v1",
  recipient: "Synthetic",
  routing: "Synthetic",
  data: "Synthetic",
};
const policy: AiPolicy = {
  ...common,
  id: h("pg-giga-policy"),
  provider: "gigachat",
  model: "GigaChat-3-Ultra",
  routing: "GIGACHAT_API_PERS",
};
const mode: AiRequestModeSnapshot = {
  mode: "minimum",
  catalogId: h("pg-giga-catalog"),
  policy,
  execution: {
    key: h("pg-giga-execution"),
    policy,
    maxInputBytes: 2048,
    maxOutputTokens: 64,
  },
};
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert(base);
  const url = new URL(base);
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert(
    ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
      (url.port === "55438" && url.pathname === "/citygo_synthetic"),
  );
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  const name = "cg_giga_fee_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_giga_fee_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base),
    cleanup: { db?: Database } = {};
  let created = false;
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
  const repoFor = (sql: Database) =>
      new Repository(sql, true, CITYGO_10X_TARIFF, false, "fixed5_overdraft"),
    repo = repoFor(db);
  await repo.initializeAiRouting(common);
  const ledger = new AiCreditLedger(
      db,
      "routerai_citygo_10x",
      false,
      "fixed5_overdraft",
    ),
    fees = new GigaChatFixedFees(db);
  const users: string[] = [];
  for (let i = 0; i < 2; i++) {
    const user = await repo.register(
      randomUUID() + "@example.test",
      "synthetic",
    );
    await repo.aiConsent(user, { policy: common, revision: 1 });
    await ledger.grantWelcome(user, user);
    users.push(user);
  }
  const router = {
    key: h("pg-giga-router-rule"),
    policy: {
      ...common,
      id: h("pg-giga-router-policy"),
      model: "synthetic/router",
    },
    maxInputBytes: 2048,
    maxOutputTokens: 64,
  };
  await repo.changeAiBudget(
    users[0]!,
    {
      expectedRevision: 1,
      enabled: true,
      mode: "routerai_balance",
      currency: "RUB",
      dailyLimitMicros: null,
      totalLimitMicros: null,
      userDailyLimitMicros: null,
      rules: [{ key: router.key, attemptCeilingMicros: 1000000 }],
    },
    [router],
  );
  async function begin(userId = users[0]!) {
    const threadId = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
        [userId],
      )
    ).rows[0]!.id;
    const requestId = randomUUID(),
      reservation = await repo.reserveChat(
        userId,
        threadId,
        requestId,
        "Question",
        {
          policyId: common.id,
          revision: 1,
          userDailyLimit: 100,
          globalDailyLimit: 200,
          modeSnapshot: mode,
        },
      );
    return {
      userId,
      threadId,
      requestId,
      lease: reservation.lease,
      attempt: {
        userId,
        threadId,
        requestId,
        lease: reservation.lease,
        attemptNumber: 1,
        provider: "gigachat" as const,
        model: policy.model,
        policyId: policy.id,
        consentPolicyId: common.id,
        routingRevision: 1,
        userDailyLimit: 100,
        globalDailyLimit: 200,
        execution: mode.execution,
        mode: { id: "minimum" as const, catalogId: mode.catalogId },
        fixedFee: {
          pricingId: h("pg-flat3"),
          accountRef: h("pg-giga-account"),
          scope: "GIGACHAT_API_PERS" as const,
        },
      },
    };
  }
  const finish = (
    request: Awaited<ReturnType<typeof begin>>,
    holdId: string,
    complete = true,
  ) => ({
    ...request,
    holdId,
    agent: "support" as const,
    content: complete ? "Answer" : "Partial",
    complete,
    generation: {
      provider: "gigachat" as const,
      requestedModel: policy.model,
      model: policy.model,
    },
  });
  return { db, repo, repoFor, users, ledger, fees, begin, finish };
}
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function tagged(
  db: Database,
  tag: string,
  fragment: string,
  gate?: {
    entered: ReturnType<typeof signal>;
    release: ReturnType<typeof signal>;
  },
): Database {
  let held = false;
  return {
    ...db,
    transaction: (work) =>
      db.transaction(async (tx) => {
        await tx.query("select set_config('application_name',$1,true)", [tag]);
        return work({
          exec: (s) => tx.exec(s),
          query: async <T>(sql: string, p?: unknown[]) => {
            const r = await tx.query<T>(sql, p);
            if (gate && !held && sql.startsWith(fragment)) {
              held = true;
              gate.entered.open();
              await gate.release.promise;
            }
            return r;
          },
        });
      }),
  };
}
async function within<T>(p: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Giga lock barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(db: Database, waiter: string, holder: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (
      (
        await db.query<{ blocked: boolean }>(
          `select exists(select 1 from pg_stat_activity w join pg_stat_activity h
 on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=$1 and h.application_name=$2
 and w.wait_event_type='Lock' and w.pid<>h.pid) as blocked`,
          [waiter, holder],
        )
      ).rows[0]!.blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    "Independent PostgreSQL backend did not wait on a real fee admission lock",
  );
}
const observed = <T>(p: Promise<T>) => {
  void p.catch(() => {});
  return p;
};
test(
  "PostgreSQL one PERS account admits exactly one of two users and rolls back the loser's attempt and five-ruble hold",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      a = await f.begin(f.users[0]),
      b = await f.begin(f.users[1]),
      gate = { entered: signal(), release: signal() },
      tag = "cg_giga_" + randomUUID().replaceAll("-", "");
    const first = observed(
      f
        .repoFor(
          tagged(
            f.db,
            tag + "_first",
            "update gigachat_account_leases set lease_token=$2",
            gate,
          ),
        )
        .reserveAiAttempt(a.attempt),
    );
    let second: ReturnType<Repository["reserveAiAttempt"]> | undefined;
    try {
      await within(gate.entered.promise);
      second = observed(
        f
          .repoFor(tagged(f.db, tag + "_second", ""))
          .reserveAiAttempt(b.attempt),
      );
      await blocked(f.db, tag + "_second", tag + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    assert(await first);
    assert(second);
    await assert.rejects(second, status(503));
    assert.equal((await f.ledger.status(f.users[0]!)).heldMicros, 5000000);
    assert.equal((await f.ledger.status(f.users[1]!)).heldMicros, 0);
    assert.equal(
      (await f.db.query("select 1 from ai_model_attempts")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select 1 from gigachat_request_fees")).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from gigachat_account_leases where lease_token is not null",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select reserved_attempts as n from ai_model_attempt_daily",
        )
      ).rows[0]!.n,
      1,
    );
  },
);
test(
  "PostgreSQL duplicate successful callbacks serialize and create one message and one three-ruble posting",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      r = await f.begin(),
      hold = await f.repo.reserveAiAttempt(r.attempt);
    assert(hold);
    await f.fees.dispatch(r.userId, hold);
    const gate = { entered: signal(), release: signal() },
      tag = "cg_giga_" + randomUUID().replaceAll("-", "");
    const first = observed(
      f
        .repoFor(
          tagged(
            f.db,
            tag + "_first",
            "update gigachat_request_fees set state='succeeded'",
            gate,
          ),
        )
        .finishGigaChat(f.finish(r, hold)),
    );
    let second: ReturnType<Repository["finishGigaChat"]> | undefined;
    try {
      await within(gate.entered.promise);
      second = observed(
        f
          .repoFor(tagged(f.db, tag + "_second", ""))
          .finishGigaChat(f.finish(r, hold)),
      );
      await blocked(f.db, tag + "_second", tag + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    const message = await first;
    assert(second);
    assert.equal(await second, message);
    assert.equal((await f.ledger.status(r.userId)).spentMicros, 3000000);
    assert.equal((await f.ledger.status(r.userId)).heldMicros, 0);
    assert.equal(
      (
        await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
          hold,
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from messages where thread_id=$1 and role='assistant'",
          [r.threadId],
        )
      ).rows.length,
      1,
    );
  },
);
test(
  "PostgreSQL restricted API preserves fixed-fee conservation and Worker has no fee or capacity access",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    for (const role of ["citygo_api", "citygo_worker", "citygo_backup"])
      await f.db.exec(
        `do $$begin create role ${role} nologin nosuperuser nocreatedb nocreaterole;exception when duplicate_object then null;end$$`,
      );
    await f.db.exec(
      "grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
    );
    await f.db.exec(
      (
        await readFile(
          new URL("../../../deploy/postgres/grants.sql", import.meta.url),
          "utf8",
        )
      ).replace(/^\\set[^\n]*\n/gm, ""),
    );
    const api: Database = {
      ...f.db,
      query: <T>(s: string, p?: unknown[]) =>
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_api");
          return tx.query<T>(s, p);
        }),
      transaction: (work) =>
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_api");
          return work(tx);
        }),
    };
    const repo = f.repoFor(api),
      fees = new GigaChatFixedFees(api),
      r = await f.begin(),
      hold = await repo.reserveAiAttempt(r.attempt);
    assert(hold);
    await fees.dispatch(r.userId, hold);
    await assert.rejects(
      new AiCreditLedger(api).resolve(r.userId, randomUUID(), hold, {
        kind: "settle",
        amountMicros: 4000000,
      }),
      /Pending GigaChat fee/,
    );
    await repo.finishGigaChat(f.finish(r, hold, false));
    assert.equal((await f.ledger.status(r.userId)).spentMicros, 0);
    for (const table of ["gigachat_request_fees", "gigachat_account_leases"]) {
      await assert.rejects(
        api.query("delete from " + table),
        /permission denied/,
      );
      await assert.rejects(
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_worker");
          await tx.query("select 1 from " + table);
        }),
        /permission denied/,
      );
    }
  },
);

test(
  "PostgreSQL real ninety-second expiry recovers a crashed fee once without disabling guards and fences the old callback",
  { ...pgOnly, timeout: 135000 },
  async (t) => {
    const f = await fixture(t),
      r = await f.begin(),
      hold = await f.repo.reserveAiAttempt({
        ...r.attempt,
        fixedFee: { ...r.attempt.fixedFee, leaseMs: 90000 },
      });
    assert(hold);
    await f.fees.dispatch(r.userId, hold);
    const live = (
      await f.db.query<{ live: boolean; seconds: number }>(
        "select expires_at>clock_timestamp() as live,extract(epoch from expires_at-created_at)::double precision as seconds from gigachat_request_fees where hold_id=$1",
        [hold],
      )
    ).rows[0]!;
    assert.equal(live.live, true);
    assert(live.seconds > 89 && live.seconds <= 90);
    const deadline = Date.now() + 110000;
    let expired = false;
    while (Date.now() < deadline) {
      expired = (
        await f.db.query<{ expired: boolean }>(
          "select expires_at<=clock_timestamp() as expired from gigachat_request_fees where hold_id=$1",
          [hold],
        )
      ).rows[0]!.expired;
      if (expired) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(
      expired,
      true,
      "Wait for the real database deadline; no clock/timestamp or guard mutation",
    );
    assert.deepEqual(await f.fees.recoverExpired(), {
      examined: 1,
      released: 1,
      cleared: 1,
    });
    assert.equal((await f.ledger.status(r.userId)).spentMicros, 0);
    assert.equal((await f.ledger.status(r.userId)).heldMicros, 0);
    await assert.rejects(f.repo.finishGigaChat(f.finish(r, hold)), status(409));
    assert.deepEqual(await f.fees.recoverExpired(), {
      examined: 0,
      released: 0,
      cleared: 0,
    });
    assert.equal(
      (
        await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
          hold,
        ])
      ).rows.length,
      1,
    );
    const next = await f.begin(f.users[1]),
      newHold = await f.repo.reserveAiAttempt(next.attempt);
    assert(newHold);
    assert.notEqual(
      (await f.fees.get(next.userId, newHold)).leaseToken,
      (await f.fees.get(r.userId, hold)).leaseToken,
    );
  },
);

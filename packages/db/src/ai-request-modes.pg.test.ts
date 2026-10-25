import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { CITYGO_10X_TARIFF, type AiPolicy } from "@citygo/contracts";
import {
  AiCreditLedger,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type AiRequestModeSnapshot,
  type Database,
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
  id: h("pg-mode-consent-bundle"),
  provider: "routerai",
  model: "citygo-bundle",
  version: "synthetic-v1",
  recipient: "Approved recipients",
  routing: "bundle routing",
  data: "approved context",
};
function profile(
  mode: "maximum" | "balanced" = "balanced",
): AiRequestModeSnapshot {
  const policy = {
    ...common,
    id: h(mode + "-pg-policy"),
    model: "synthetic/" + mode,
  };
  return {
    mode,
    catalogId: h("pg-catalog"),
    policy,
    execution: {
      key: h(mode + "-pg-execution"),
      policy: { ...policy },
      maxInputBytes: 2048,
      maxOutputTokens: 64,
    },
    upstream: mode === "maximum" ? "synthetic-openai" : "synthetic-deepseek",
  };
}
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
  const name = "cg_ai_modes_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_ai_modes_test_[a-f0-9]{32}$/);
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
  const repoFor = (sql: Database) =>
    new Repository(sql, true, CITYGO_10X_TARIFF, false, "fixed5_overdraft");
  const repo = repoFor(db),
    user = await repo.register(randomUUID() + "@example.test", "synthetic");
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  await repo.initializeAiRouting(common);
  const routing = await repo.aiRouting();
  await repo.aiConsent(user, { policy: common, revision: routing.revision });
  const profiles = [profile(), profile("maximum")];
  await repo.changeAiBudget(
    user,
    {
      expectedRevision: 1,
      enabled: true,
      currency: "RUB",
      mode: "routerai_balance",
      dailyLimitMicros: null,
      totalLimitMicros: null,
      userDailyLimitMicros: null,
      rules: profiles.map((p) => ({
        key: p.execution.key,
        attemptCeilingMicros: 1_000_000,
      })),
    },
    profiles.map((p) => p.execution),
  );
  await new AiCreditLedger(db).grantWelcome(user, user);
  const requestId = randomUUID();
  const access = (p: AiRequestModeSnapshot) => ({
    policyId: common.id,
    revision: routing.revision,
    userDailyLimit: 100,
    globalDailyLimit: 200,
    modeSnapshot: p,
  });
  const attempt = (p: AiRequestModeSnapshot, lease: string) => ({
    userId: user,
    threadId: thread,
    requestId,
    lease,
    attemptNumber: 1,
    provider: p.policy.provider,
    model: p.policy.model,
    policyId: p.policy.id,
    consentPolicyId: common.id,
    routingRevision: routing.revision,
    userDailyLimit: 100,
    globalDailyLimit: 200,
    execution: p.execution,
    upstream: p.upstream,
    mode: { id: p.mode, catalogId: p.catalogId },
  });
  const money = async () =>
    (
      await db.query(`select jsonb_build_object(
    'accounts',(select jsonb_agg(to_jsonb(t) order by user_id) from ai_credit_accounts t),
    'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t),
    'lots',(select jsonb_agg(to_jsonb(t) order by id) from credit_source_lots t),
    'attempts',(select jsonb_agg(to_jsonb(t) order by thread_id,request_id,attempt_number) from ai_model_attempts t),
    'budget',(select jsonb_agg(to_jsonb(t)) from ai_budget t),
    'budgetdaily',(select jsonb_agg(to_jsonb(t) order by usage_day) from ai_budget_daily t)) as snapshot`)
    ).rows;
  return {
    db,
    repo,
    repoFor,
    user,
    thread,
    routing,
    requestId,
    access,
    attempt,
    money,
  };
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
          query: async <T>(sql: string, params?: unknown[]) => {
            const r = await tx.query<T>(sql, params);
            if (
              gate &&
              !held &&
              sql.startsWith("insert into ai_request_modes(")
            ) {
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
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("AI mode lock barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function blocked(db: Database, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
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
    "Independent PostgreSQL backend did not actually wait on the admitted request lock",
  );
}
const observed = <T>(p: Promise<T>) => {
  void p.catch(() => {});
  return p;
};

test(
  "PostgreSQL competing modes on one request serialize and freeze one winner without duplicate questions, quotas or holds",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      before = await f.money(),
      gate = { entered: signal(), release: signal() },
      tag = "cg_modes_" + randomUUID().replaceAll("-", "");
    const first = observed(
      f
        .repoFor(tagged(f.db, tag + "_first", gate))
        .reserveChat(
          f.user,
          f.thread,
          f.requestId,
          "Accepted question",
          f.access(profile()),
        ),
    );
    let second: ReturnType<Repository["reserveChat"]> | undefined;
    try {
      await within(gate.entered.promise);
      second = observed(
        f
          .repoFor(tagged(f.db, tag + "_second"))
          .reserveChat(
            f.user,
            f.thread,
            f.requestId,
            "Retargeted question",
            f.access(profile("maximum")),
          ),
      );
      await blocked(f.db, tag + "_second", tag + "_first");
    } finally {
      gate.release.open();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
    assert.equal((await first).modeSnapshot?.mode, "balanced");
    assert(second);
    await assert.rejects(second, status(409));
    assert.deepEqual(
      (await f.db.query("select mode,model from ai_request_modes")).rows,
      [{ mode: "balanced", model: profile().policy.model }],
    );
    assert.deepEqual((await f.db.query("select content from messages")).rows, [
      { content: "Accepted question" },
    ]);
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select count(*)::integer as n from chat_requests",
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select accepted_requests as n from ai_usage_daily",
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select accepted_requests as n from ai_user_usage_daily",
        )
      ).rows[0]!.n,
      1,
    );
    assert.deepEqual(await f.money(), before);
  },
);

test(
  "PostgreSQL an admitted mode keeps its exact profile after a routing switch while new requests fail closed",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      selected = profile(),
      r = await f.repo.reserveChat(
        f.user,
        f.thread,
        f.requestId,
        "Question",
        f.access(selected),
      );
    const routing = await f.repo.changeAiRouting(
      f.user,
      {
        provider: "disabled",
        policyId: null,
        expectedRevision: f.routing.revision,
      },
      null,
    );
    const before = await f.money();
    await assert.rejects(
      f.repo.reserveAiAttempt({
        ...f.attempt(selected, r.lease),
        mode: { id: "maximum", catalogId: selected.catalogId },
      }),
      status(409),
    );
    assert.deepEqual(await f.money(), before);
    assert(await f.repo.reserveAiAttempt(f.attempt(selected, r.lease)));
    assert.equal(
      (await new AiCreditLedger(f.db).status(f.user)).heldMicros,
      5_000_000,
    );
    assert.deepEqual(await f.repo.aiRouting(), routing);
    assert.deepEqual(
      (
        await f.db.query(
          "select mode,model,execution_key,consent_policy_id from ai_request_modes",
        )
      ).rows,
      [
        {
          mode: selected.mode,
          model: selected.policy.model,
          execution_key: selected.execution.key,
          consent_policy_id: common.id,
        },
      ],
    );
    await assert.rejects(
      f.repo.reserveChat(
        f.user,
        f.thread,
        randomUUID(),
        "New question",
        f.access(profile("maximum")),
      ),
      status(409),
    );
  },
);

test(
  "PostgreSQL real API grants append/read modes but cannot retarget or delete; Worker remains unable to read modes",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    for (const role of ["citygo_api", "citygo_worker", "citygo_backup"])
      await f.db.exec(
        `do $$ begin create role ${role} nologin nosuperuser nocreatedb nocreaterole; exception when duplicate_object then null; end $$`,
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
    const r = await f
      .repoFor(api)
      .reserveChat(
        f.user,
        f.thread,
        f.requestId,
        "Question",
        f.access(profile()),
      );
    const beforeAttempt = await f.money();
    for (const [model, policy, key] of [
      ["changed", profile().policy.id, profile().execution.key],
      [profile().policy.model, h("changed-policy"), profile().execution.key],
      [profile().policy.model, profile().policy.id, h("changed-execution")],
    ])
      await assert.rejects(
        api.query(
          `insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,
 money_currency,money_reserved_micros,money_budget_revision,money_rule_key)
 values($1,$2,1,$3,'routerai',$4,$5,$6,'RUB',1000000,2,$7)`,
          [
            f.thread,
            f.requestId,
            f.user,
            model,
            policy,
            f.routing.revision,
            key,
          ],
        ),
        /does not match the frozen request mode/,
      );
    assert.deepEqual(await f.money(), beforeAttempt);
    assert(
      await f.repoFor(api).reserveAiAttempt(f.attempt(profile(), r.lease)),
    );
    const before = await f.money();
    assert.equal(
      (await api.query("select 1 from ai_request_modes")).rows.length,
      1,
    );
    for (const sql of [
      "update ai_request_modes set mode='maximum'",
      "delete from ai_request_modes",
    ])
      await assert.rejects(api.query(sql), /permission denied/);
    await assert.rejects(
      f.db.transaction(async (tx) => {
        await tx.exec("set local role citygo_worker");
        await tx.query("select 1 from ai_request_modes");
      }),
      /permission denied/,
    );
    await f.db.transaction(async (tx) => {
      await tx.exec("set local role citygo_worker");
      await tx.query("update chat_requests set status='interrupted'");
    });
    assert.deepEqual(await f.money(), before);
    await assert.rejects(
      f.db.exec("update ai_request_modes set model='changed'"),
      /immutable and retained/,
    );
  },
);

import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { CITYGO_10X_TARIFF, type AiPolicy } from "@citygo/contracts";
import { AiCreditCharges } from "./ai-credit-charges.js";
import {
  AiCreditLedger,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type AiRequestModeSnapshot,
} from "./index.js";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
const common: AiPolicy = {
  id: h("consent-bundle"),
  provider: "routerai",
  model: "citygo-bundle",
  version: "synthetic-v1",
  recipient: "Approved recipients",
  routing: "bundle routing",
  data: "approved context",
};
const snapshot = (
  mode: "maximum" | "balanced" = "balanced",
): AiRequestModeSnapshot => {
  const policy: AiPolicy = {
    ...common,
    id: h(mode + "-policy"),
    model: mode === "maximum" ? "synthetic/maximum" : "synthetic/balanced",
  };
  return {
    mode,
    catalogId: h("catalog-v1"),
    policy,
    execution: {
      key: h(mode + "-execution"),
      policy: { ...policy },
      maxInputBytes: 2048,
      maxOutputTokens: 64,
    },
    upstream: mode === "maximum" ? "synthetic-openai" : "synthetic-deepseek",
  };
};
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(
      db,
      true,
      CITYGO_10X_TARIFF,
      false,
      "fixed5_overdraft",
    ),
    user = await repo.register("modes@example.test", "synthetic-hash");
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  await repo.initializeAiRouting(common);
  const routing = await repo.aiRouting();
  await repo.aiConsent(user, { policy: common, revision: routing.revision });
  const profiles = [snapshot("balanced"), snapshot("maximum")];
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
  const access = (p: AiRequestModeSnapshot) => ({
    policyId: common.id,
    revision: routing.revision,
    userDailyLimit: 100,
    globalDailyLimit: 200,
    modeSnapshot: p,
  });
  const requestId = randomUUID();
  const attempt = (
    p: AiRequestModeSnapshot,
    lease: string,
    id = requestId,
  ) => ({
    userId: user,
    threadId: thread,
    requestId: id,
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
  const rows = async () =>
    (
      await db.query(`select jsonb_build_object(
 'threads',(select jsonb_agg(to_jsonb(t) order by id) from agent_threads t),
 'requests',(select jsonb_agg(to_jsonb(t) order by thread_id,request_id) from chat_requests t),
 'modes',(select jsonb_agg(to_jsonb(t) order by thread_id,request_id) from ai_request_modes t),
 'messages',(select jsonb_agg(to_jsonb(t) order by id) from messages t),
 'daily',(select jsonb_agg(to_jsonb(t) order by usage_day) from ai_usage_daily t),
 'attempts',(select jsonb_agg(to_jsonb(t) order by thread_id,request_id,attempt_number) from ai_model_attempts t),
 'attemptdaily',(select jsonb_agg(to_jsonb(t) order by usage_day) from ai_model_attempt_daily t),
 'budget',(select jsonb_agg(to_jsonb(t)) from ai_budget t),
 'budgetdaily',(select jsonb_agg(to_jsonb(t) order by usage_day) from ai_budget_daily t),
 'accounts',(select jsonb_agg(to_jsonb(t) order by user_id) from ai_credit_accounts t),
 'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t),
 'charges',(select jsonb_agg(to_jsonb(t) order by hold_id) from ai_credit_charges t),
 'lots',(select jsonb_agg(to_jsonb(t) order by id) from credit_source_lots t)) as snapshot`)
    ).rows;
  return { db, repo, user, thread, routing, access, attempt, requestId, rows };
}
test("a mode is frozen before counters/money; changing selectors cannot retarget the accepted profile and subsequent requests keep the same history", async (t) => {
  const f = await fixture(t),
    selected = snapshot(),
    original = structuredClone(selected),
    request = await f.repo.reserveChat(
      f.user,
      f.thread,
      f.requestId,
      "First question",
      f.access(selected),
    );
  selected.policy.model = "mutated caller";
  selected.execution.maxOutputTokens = 1;
  assert.deepEqual(request.modeSnapshot, original);
  const hold = await f.repo.reserveAiAttempt(
    f.attempt(original, request.lease),
  );
  assert(hold);
  assert.equal(
    (await new AiCreditLedger(f.db).status(f.user)).heldMicros,
    5_000_000,
  );
  const charges = new AiCreditCharges(
      f.db,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
    ),
    generation = "synthetic_" + randomUUID();
  await charges.dispatch(f.user, hold);
  await charges.identify(f.user, hold, generation);
  await f.repo.finishChat(
    f.thread,
    f.requestId,
    request.lease,
    "support",
    "First answer",
    true,
    true,
    {
      provider: "routerai",
      requestedModel: original.policy.model,
      model: original.policy.model,
    },
    hold,
  );
  await charges.settle(f.user, hold, {
    generationId: generation,
    reference: hold,
    model: original.policy.model,
    upstream: original.upstream!,
    currency: "RUB",
    costRub: "0.217",
    amountMicros: 217000,
  });
  assert.equal(
    (await new AiCreditLedger(f.db).status(f.user)).spentMicros,
    2_170_000,
  );
  assert.equal((await new AiCreditLedger(f.db).status(f.user)).heldMicros, 0);
  const next = await f.repo.reserveChat(
    f.user,
    f.thread,
    randomUUID(),
    "Last question",
    f.access(snapshot("maximum")),
  );
  assert.deepEqual(
    next.messages.map((m) => m.content),
    ["First question", "First answer", "Last question"],
  );
  assert.equal(next.modeSnapshot?.mode, "maximum");
  assert.deepEqual(await f.repo.aiRouting(), f.routing);
  assert.deepEqual(
    (
      await f.db.query(
        "select mode,model from ai_request_modes order by created_at",
      )
    ).rows,
    [
      { mode: "balanced", model: original.policy.model },
      { mode: "maximum", model: snapshot("maximum").policy.model },
    ],
  );
});
test("stored mode rejects omission and any changed profile/catalog/consent/execution/upstream before accounting", async (t) => {
  const f = await fixture(t),
    p = snapshot(),
    r = await f.repo.reserveChat(
      f.user,
      f.thread,
      f.requestId,
      "Question",
      f.access(p),
    ),
    input = f.attempt(p, r.lease),
    before = await f.rows();
  for (const patch of [
    { mode: undefined },
    { mode: { id: "maximum" as const, catalogId: p.catalogId } },
    { mode: { id: p.mode, catalogId: h("other-catalog") } },
    { consentPolicyId: h("other-consent") },
    { upstream: "other-upstream" },
    { execution: { ...p.execution, maxOutputTokens: 65 } },
    { execution: { ...p.execution, key: h("other-key") } },
    { model: "other-model" },
  ])
    await assert.rejects(
      f.repo.reserveAiAttempt({ ...input, ...patch }),
      status(409),
    );
  assert.deepEqual(await f.rows(), before);
  const valid = await f.repo.reserveAiAttempt(input);
  assert(valid);
  const admitted = await f.rows();
  await assert.rejects(f.repo.reserveAiAttempt(input), status(409));
  assert.deepEqual(await f.rows(), admitted);
});
test("malformed or secret-bearing snapshots never create a question, mode, quota or financial record", async (t) => {
  const f = await fixture(t),
    before = await f.rows(),
    p = snapshot();
  for (const bad of [
    { ...p, mode: "unknown" },
    { ...p, catalogId: "bad" },
    { ...p, apiKey: "not-a-real-key" },
    {
      ...p,
      execution: {
        ...p.execution,
        policy: { ...p.policy, model: "different" },
      },
    },
    { ...p, execution: { ...p.execution, key: "bad" } },
    { ...p, upstream: undefined },
    { ...p, policy: { ...p.policy, secret: "canary" } },
  ]) {
    await assert.rejects(
      f.repo.reserveChat(
        f.user,
        f.thread,
        f.requestId,
        "Question",
        f.access(bad as AiRequestModeSnapshot),
      ),
      status(400),
    );
  }
  assert.deepEqual(await f.rows(), before);
});
test("mode, original request ID and ownership are retained; rejected message persistence rolls the mode and all admission counters back", async (t) => {
  const f = await fixture(t),
    before = await f.rows();
  await f.db.exec(
    "create function synthetic_mode_message_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic message failure';end$$;create trigger synthetic_mode_message_failure before insert on messages for each row execute function synthetic_mode_message_failure()",
  );
  await assert.rejects(
    f.repo.reserveChat(
      f.user,
      f.thread,
      f.requestId,
      "Question",
      f.access(snapshot()),
    ),
    /synthetic message failure/,
  );
  assert.deepEqual(await f.rows(), before);
  await f.db.exec(
    "drop trigger synthetic_mode_message_failure on messages;drop function synthetic_mode_message_failure()",
  );
  const r = await f.repo.reserveChat(
    f.user,
    f.thread,
    f.requestId,
    "Question",
    f.access(snapshot()),
  );
  await f.repo.finishChat(
    f.thread,
    f.requestId,
    r.lease,
    "support",
    "No model called",
    true,
    false,
  );
  const accepted = await f.rows();
  await assert.rejects(
    f.repo.reserveChat(
      f.user,
      f.thread,
      f.requestId,
      "Changed request",
      f.access(snapshot("maximum")),
    ),
    status(409),
  );
  assert.deepEqual(await f.rows(), accepted);
  for (const sql of [
    "update ai_request_modes set mode='maximum'",
    "delete from ai_request_modes",
  ])
    await assert.rejects(f.db.exec(sql), /immutable and retained/);
});
test("API can append/read the frozen mode but cannot rewrite/delete it; Worker has no mode access", async (t) => {
  const f = await fixture(t);
  await f.db.exec(
    "create role citygo_api nologin;create role citygo_worker nologin;create role citygo_backup nologin;grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  const grants = (
    await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    )
  ).replace(/^\\set[^\n]*\n/gm, "");
  await f.db.exec(grants);
  await f.db.exec("set role citygo_api");
  const r = await f.repo.reserveChat(
    f.user,
    f.thread,
    f.requestId,
    "Question",
    f.access(snapshot()),
  );
  assert.equal(
    (await f.db.query("select 1 from ai_request_modes")).rows.length,
    1,
  );
  assert(await f.repo.reserveAiAttempt(f.attempt(snapshot(), r.lease)));
  for (const sql of [
    "update ai_request_modes set mode='maximum'",
    "delete from ai_request_modes",
  ])
    await assert.rejects(f.db.exec(sql), /permission denied/);
  await f.db.exec("reset role;set role citygo_worker");
  await assert.rejects(
    f.db.query("select 1 from ai_request_modes"),
    /permission denied/,
  );
  await f.db.query("update chat_requests set status='interrupted'");
});
test("direct attempt INSERTs cannot bypass frozen selected fields, execution rule or common consent", async (t) => {
  const f = await fixture(t),
    selected = snapshot(),
    request = await f.repo.reserveChat(
      f.user,
      f.thread,
      f.requestId,
      "Question",
      f.access(selected),
    ),
    before = await f.rows();
  const insert = (
    change: {
      provider?: string;
      model?: string;
      policyId?: string;
      revision?: number;
      key?: string;
    } = {},
  ) =>
    f.db.query(
      `insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,
 money_currency,money_reserved_micros,money_budget_revision,money_rule_key)
 values($1,$2,1,$3,$4,$5,$6,$7,'RUB',1000000,2,$8)`,
      [
        f.thread,
        f.requestId,
        f.user,
        change.provider ?? selected.policy.provider,
        change.model ?? selected.policy.model,
        change.policyId ?? selected.policy.id,
        change.revision ?? f.routing.revision,
        change.key ?? selected.execution.key,
      ],
    );
  for (const changed of [
    { provider: "openai" },
    { model: "changed" },
    { policyId: h("changed-policy") },
    { revision: f.routing.revision + 1 },
    { key: h("changed-execution") },
  ])
    await assert.rejects(
      insert(changed),
      /does not match the frozen request mode/,
    );
  assert.deepEqual(await f.rows(), before);
  await f.db.query("update chat_requests set ai_policy_id=$1", [
    h("changed-common-consent"),
  ]);
  await assert.rejects(insert(), /does not match the frozen request mode/);
  await f.db.query("update chat_requests set ai_policy_id=$1", [common.id]);
  assert.deepEqual(await f.rows(), before);
  assert(await f.repo.reserveAiAttempt(f.attempt(selected, request.lease)));
});

test("migration33 leaves historical requests/messages/attempts and money unchanged without inventing mode rows", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0033_")
    .sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    await db.exec(sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""));
    await db.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [name, h(sql.replaceAll("\r\n", "\n"))],
    );
  }
  const user = await new Repository(db).register(
      "historical-mode@example.test",
      "hash",
    ),
    thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
        [user],
      )
    ).rows[0]!.id,
    id = randomUUID();
  await db.query(
    "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'complete',$3,1)",
    [thread, id, common.id],
  );
  await db.query(
    "insert into messages(thread_id,role,content) values($1,'user','Historical question'),($1,'assistant','Historical answer')",
    [thread],
  );
  const snap = async () =>
    (
      await db.query(`select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(t)) from chat_requests t),
 'messages',(select jsonb_agg(to_jsonb(t) order by id) from messages t),'attempts',(select jsonb_agg(to_jsonb(t)) from ai_model_attempts t),
 'credits',(select jsonb_agg(to_jsonb(t)) from ai_credit_entries t)) as snapshot`)
    ).rows;
  const before = await snap();
  await migrate(db);
  assert.deepEqual(await snap(), before);
  assert.equal(
    (await db.query("select 1 from ai_request_modes")).rows.length,
    0,
  );
});

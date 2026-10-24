import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  AccountReset,
  DomainError,
  Repository,
  connectDatabase,
  migrate,
  type Database,
} from "./index.js";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db);
  const ids: string[] = [];
  for (let n = 0; n < 5; n++)
    ids.push(
      await repo.register(
        `synthetic-${n}@example.test`,
        "synthetic-private-hash",
      ),
    );
  return { db, ids, reset: new AccountReset(db) };
}
async function snapshot(db: Database) {
  const tables = (
    await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
  ).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
    result[tablename] = (
      await db.query(
        `select row_to_json(x) as value from ${tablename} x order by row_to_json(x)::text`,
      )
    ).rows;
  }
  return result;
}

test("reset default is a nonmutating count-only plan, never an apply or account listing", async (t) => {
  const { db, reset } = await fixture(t);
  const before = await snapshot(db);
  const plan = await reset.plan();
  assert.equal(plan.dryRun, true);
  assert.equal(plan.writesEnabled, false);
  assert.equal(plan.accountsDeleted, 0);
  assert.equal(plan.accountCount, 5);
  assert.equal(plan.counts.user_credentials, 5);
  assert.equal(plan.expectedUserCount, null);
  assert.match(plan.accountSetFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(
    plan.blockers.some(
      (blocker) => blocker.code === "RESET_APPLY_NOT_IMPLEMENTED",
    ),
  );
  assert.ok(
    plan.blockers.some(
      (blocker) => blocker.code === "EXPECTED_USER_COUNT_NOT_PINNED",
    ),
  );
  assert.ok(
    plan.blockers.some(
      (blocker) => blocker.code === "MAINTENANCE_NOT_CONFIRMED",
    ),
  );
  const encoded = JSON.stringify(plan);
  for (const sensitive of [
    "synthetic-private-hash",
    "@example.test",
    "auth_subject",
    "password_hash",
  ])
    assert.equal(encoded.includes(sensitive), false);
  assert.equal("apply" in reset, false);
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual(await reset.plan(), plan);
});

test("exact account count and explicit maintenance remain diagnostic guards, not permission to delete", async (t) => {
  const { reset, db } = await fixture(t);
  const matched = await reset.plan({
    expectedUserCount: 5,
    maintenanceConfirmed: true,
  });
  assert.deepEqual(matched.blockers, [
    { code: "RESET_APPLY_NOT_IMPLEMENTED", count: 1 },
  ]);
  assert.equal(matched.accountsDeleted, 0);
  assert.equal(matched.maintenanceConfirmed, true);
  const mismatch = await reset.plan({
    expectedUserCount: 4,
    maintenanceConfirmed: true,
  });
  assert.ok(
    mismatch.blockers.some(
      (blocker) => blocker.code === "EXPECTED_USER_COUNT_MISMATCH",
    ),
  );
  for (const expected of [-1, 1.5, 1001, NaN, Infinity])
    await assert.rejects(
      reset.plan({ expectedUserCount: expected }),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 400,
    );
  assert.equal((await db.query("select id from users")).rows.length, 5);
});

test("active requests and even expired unreleased leases are explicit blockers without forced cleanup", async (t) => {
  const { db, reset, ids } = await fixture(t);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,busy_until,lease_token) values ($1,'support',now()-interval '1 minute','synthetic-lease') returning id::text",
      [ids[0]],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into chat_requests(thread_id,request_id,status) values ($1,$2,'running')",
    [thread, randomUUID()],
  );
  await db.query(
    "insert into messages(thread_id,role,content) values ($1,'user','PRIVATE CHAT MUST NOT APPEAR')",
    [thread],
  );
  const before = await snapshot(db);
  const plan = await reset.plan({
    expectedUserCount: 5,
    maintenanceConfirmed: true,
  });
  assert.ok(
    plan.blockers.some(
      (blocker) =>
        blocker.code === "ACTIVE_CHAT_REQUESTS" && blocker.count === 1,
    ),
  );
  assert.ok(
    plan.blockers.some(
      (blocker) =>
        blocker.code === "UNRELEASED_GENERATION_LEASES" && blocker.count === 1,
    ),
  );
  assert.equal(plan.counts.messages, 1);
  assert.equal(JSON.stringify(plan).includes("PRIVATE CHAT"), false);
  assert.equal(JSON.stringify(plan).includes("synthetic-lease"), false);
  assert.deepEqual(await snapshot(db), before);
});

test("real-cost ledger, pending holds and receipts are inventoried but never reset or released", async (t) => {
  const { db, reset, ids } = await fixture(t);
  const user = ids[0]!;
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros,held_micros) values ($1,500000000,100000)",
    [user],
  );
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id) values ($1,$2,'bonus',500000000,$3)",
    [user, randomUUID(), ids[1]],
  );
  const hold = randomUUID();
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'hold',100000)",
    [user, hold],
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values ($1,'support') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  const request = randomUUID();
  await db.query(
    "insert into chat_requests(thread_id,request_id,status) values ($1,$2,'complete')",
    [thread, request],
  );
  await db.query(
    "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key) values ($1,$2,1,$3,'routerai','synthetic-model',$4,1,'RUB',100000,1,$4)",
    [thread, request, user, "a".repeat(64)],
  );
  await db.query(
    "insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,dispatched,generation_id) values ($1,$2,$3,$4,1,'synthetic-model','synthetic',true,'private-generation-identifier')",
    [hold, user, thread, request],
  );
  await db.query(
    "update ai_budget set currency='RUB',total_limit_micros=900000000,total_reserved_micros=100000 where id=1",
  );
  await db.query(
    "insert into ai_budget_daily(usage_day,reserved_micros) values (current_date,100000)",
  );
  await db.query(
    "insert into ai_model_attempt_daily(usage_day,reserved_attempts,user_limit,global_limit) values (current_date,1,100,1000)",
  );
  await db.query(
    "insert into ai_usage_daily(usage_day,accepted_requests) values (current_date,1)",
  );
  const before = await snapshot(db);
  const plan = await reset.plan({
    expectedUserCount: 5,
    maintenanceConfirmed: true,
  });
  for (const code of [
    "NONZERO_CREDIT_BALANCES",
    "PENDING_CREDIT_HOLDS",
    "UNRECONCILED_PROVIDER_CHARGES",
    "ACCOUNTING_ANONYMIZATION_REQUIRED",
  ])
    assert.ok(
      plan.blockers.some((blocker) => blocker.code === code),
      code,
    );
  assert.equal(plan.counts.ai_credit_charges, 1);
  assert.equal(plan.counts.ai_model_attempts, 1);
  assert.equal(plan.counts.ai_credit_entries, 2);
  assert.equal(
    JSON.stringify(plan).includes("private-generation-identifier"),
    false,
  );
  assert.deepEqual(await snapshot(db), before);
  for (const table of [
    "ai_budget",
    "ai_budget_daily",
    "ai_model_attempt_daily",
    "ai_usage_daily",
    "ai_routing",
    "citygo_migrations",
    "server_secrets",
    "backups_and_external_storage",
  ])
    assert.ok(plan.retained.includes(table), table);
});

test("external artifacts and unattributed audit context need a separate erasure review", async (t) => {
  const { db, reset, ids } = await fixture(t);
  await db.query(
    "insert into generated_artifacts(user_id,kind,storage_key) values ($1,'resume','private-object-storage-key')",
    [ids[0]],
  );
  await db.query(
    "insert into audit_log(action,entity_type,entity_id,payload) values ('old-event','unknown','private-id','{\"email\":\"private@example.test\"}')",
  );
  await db.query(
    "insert into audit_log(action,entity_type,entity_id,payload) values ('ai-budget-changed','ai-budget','1','{}')",
  );
  await db.query(
    "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'ai-routing-changed','ai-routing','1','{}')",
    [ids[0]],
  );
  const before = await snapshot(db);
  const plan = await reset.plan({
    expectedUserCount: 5,
    maintenanceConfirmed: true,
  });
  assert.ok(
    plan.blockers.some(
      (blocker) => blocker.code === "EXTERNAL_ARTIFACT_INVENTORY_REQUIRED",
    ),
  );
  assert.ok(
    plan.blockers.some(
      (blocker) =>
        blocker.code === "UNATTRIBUTED_AUDIT_REVIEW_REQUIRED" &&
        blocker.count === 1,
    ),
  );
  assert.equal(plan.counts.audit_log_owned_or_acted, 1);
  const encoded = JSON.stringify(plan);
  assert.equal(encoded.includes("private-object-storage-key"), false);
  assert.equal(encoded.includes("private@example.test"), false);
  assert.deepEqual(await snapshot(db), before);
});

test("identity fingerprint changes when an account is replaced even at the same count", async (t) => {
  const { db, reset, ids } = await fixture(t);
  const first = await reset.plan({ expectedUserCount: 5 });
  await db.query("delete from users where id=$1", [ids[0]]);
  await new Repository(db).register(
    "replacement@example.test",
    "replacement-private-hash",
  );
  const next = await reset.plan({ expectedUserCount: 5 });
  assert.equal(first.accountCount, next.accountCount);
  assert.notEqual(first.accountSetFingerprint, next.accountSetFingerprint);
});

test("an empty account database can be inspected without creating bootstrap or financial rows", async (t) => {
  const { db, reset } = await fixture(t);
  // This deletion belongs only to the disposable synthetic fixture, not tooling.
  await db.query("delete from users");
  const before = await snapshot(db);
  const plan = await reset.plan({
    expectedUserCount: 0,
    maintenanceConfirmed: true,
  });
  assert.equal(plan.accountCount, 0);
  assert.equal(plan.bootstrapCompleted, false);
  assert.equal(plan.counts.payment_admission, 1);
  assert.equal(plan.counts.phone_verification_control, 1);
  assert.ok(
    Object.entries(plan.counts).every(
      ([name, count]) =>
        ["payment_admission", "phone_verification_control"].includes(name) ||
        count === 0,
    ),
  );
  assert.deepEqual(plan.blockers, [
    { code: "RESET_APPLY_NOT_IMPLEMENTED", count: 1 },
  ]);
  assert.deepEqual(await snapshot(db), before);
});

test("read-only reset inventories retained admission and reports its owner, enabled reconciliation and history blockers", async (t) => {
  const { db, ids, reset } = await fixture(t);
  await db.query(
    "update payment_admission set owner_user_id=$1,merchant_id='123456',runtime_policy_id=repeat('a',64),reconciliation_enabled=true",
    [ids[0]],
  );
  await db.query(
    "insert into payment_admission_commands(request_id,actor_user_id,merchant_id,runtime_policy_id,payload,result_revision,result) values($1,$2,'123456',repeat('a',64),'{\"action\":\"close\"}',2,'{}')",
    [randomUUID(), ids[0]],
  );
  await db.query(
    "insert into payment_admission_reconciliation_events(run_id,admission_revision,merchant_id,runtime_policy_id,success) values($1,1,'123456',repeat('a',64),false)",
    [randomUUID()],
  );
  const before = await snapshot(db);
  const plan = await reset.plan({
    expectedUserCount: 5,
    maintenanceConfirmed: true,
  });
  assert.equal(plan.counts.payment_admission, 1);
  assert.equal(plan.counts.payment_admission_commands, 1);
  assert.equal(plan.counts.payment_admission_reconciliation_events, 1);
  for (const name of [
    "payment_admission",
    "payment_admission_commands",
    "payment_admission_reconciliation_events",
  ])
    assert.ok(plan.retained.includes(name));
  assert.ok(
    plan.blockers.some(
      (item) => item.code === "PAYMENT_ADMISSION_LINKED_OR_ACTIVE",
    ),
  );
  assert.ok(
    plan.blockers.some(
      (item) =>
        item.code === "PAYMENT_ADMISSION_HISTORY_PRESENT" && item.count === 2,
    ),
  );
  assert.deepEqual(await snapshot(db), before);
  assert.equal("apply" in reset, false);
});

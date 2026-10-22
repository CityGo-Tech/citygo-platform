import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  AccountAccess,
  Repository,
  connectDatabase,
  migrate,
} from "./index.js";
import { FreshAccountReset } from "./fresh-account-reset.js";
import {
  captureRestartRows,
  migrateLegacyRestartFixture,
  seedRestartNpdObligation,
  seedRestartFixture,
  seedRestartRefundHistory,
  seedRestartPaymentNotification,
} from "./closed-account-restart-fixture.js";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrateLegacyRestartFixture(db);
  const data = await seedRestartFixture(db);
  await db.exec(
    "update ai_budget set enabled=true,daily_limit_micros=1000000,user_daily_limit_micros=500000,rules='[{}]'::jsonb where id=1",
  );
  await db.exec(
    "update account_security_state set bootstrap_completed=true where id=1",
  );
  await db.exec(
    "insert into knowledge_sources(slug,title,metadata) values ('old-private-source','PRIVATE-KNOWLEDGE','{\"private\":\"PRIVATE-KNOWLEDGE\"}')",
  );
  await db.query(
    "insert into generated_artifacts(user_id,thread_id,kind,storage_key,metadata) values ($1,$2,'synthetic','PRIVATE-EXTERNAL-OBJECT','{\"private\":true}')",
    [data.user, data.thread],
  );
  const topupId = "79176cd5-a220-4d18-86b2-2515633c0d5c";
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'topup',100000000)",
    [data.user, topupId],
  );
  await db.query(
    "update ai_credit_accounts set granted_micros=granted_micros+100000000 where user_id=$1",
    [data.user],
  );
  await db.query(
    "insert into ai_credit_topups(provider_payment_id,operation_id,user_id,paid_kopeks,credited_micros,merchant_id,test,verified_at,verification_receipt) values ('synthetic-payment',$1,$2,10000,100000000,'synthetic-merchant',false,now(),'{\"private\":\"PRIVATE-PAYMENT\"}')",
    [topupId, data.user],
  );
  await migrate(db);
  return { db, data, reset: new FreshAccountReset(db) };
}
async function prepared(reset: FreshAccountReset, count = 2) {
  const plan = await reset.plan({
    expectedUserCount: count,
    maintenanceConfirmed: true,
  });
  return {
    expectedUserCount: count,
    expectedSnapshotFingerprint: plan.snapshotFingerprint,
    backupReceiptSha256: "b".repeat(64),
    maintenanceConfirmed: true as const,
    servicesStoppedConfirmed: true as const,
    destructiveResetConfirmed: true as const,
    passwordHash: "PRIVATE-NEW-BOOTSTRAP-HASH",
  };
}

test("fresh reset plan is bounded, stable, count-only and read-only even after former bootstrap", async (t) => {
  const { db, reset } = await fixture(t);
  const before = await captureRestartRows(db);
  const plan = await reset.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.equal(plan.operation, "fresh-account-reset-plan");
  assert.equal(plan.accountsDeleted, 0);
  assert.equal(plan.bootstrapCompleted, true);
  assert.equal(plan.accountingPreserved, false);
  assert.equal(plan.externalObjectsDeleted, false);
  assert.equal(plan.counts.ai_model_attempts, 1);
  assert.equal(plan.counts.ai_credit_charges, 1);
  assert.equal(plan.counts.knowledge_sources, 1);
  assert.equal(plan.counts.ai_credit_topups, 1);
  assert.deepEqual(plan.blockers, []);
  assert.match(plan.snapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    /PRIVATE-|example.test|password_hash|synthetic-generation/.test(
      JSON.stringify(plan),
    ),
    false,
  );
  assert.deepEqual(
    await reset.plan({ expectedUserCount: 2, maintenanceConfirmed: true }),
    plan,
  );
  assert.deepEqual(await captureRestartRows(db), before);
});

test("explicit full reset deletes accounts, all money/attempt history and knowledge; preserves schema/catalogue/configuration", async (t) => {
  const { db, data, reset } = await fixture(t);
  const preservedNames = [
    "citygo_migration_lock",
    "citygo_migrations",
    "quests",
    "ai_routing",
    "payment_admission",
    "payment_admission_commands",
    "payment_admission_reconciliation_events",
  ];
  const preserved = await captureRestartRows(db, preservedNames);
  const budgetBefore = (await db.query("select * from ai_budget")).rows[0]!;
  const receipt = await reset.apply(await prepared(reset));
  assert.equal(receipt.accountsDeleted, 2);
  assert.equal(receipt.accountingPreserved, false);
  assert.equal(receipt.knowledgeEmpty, true);
  assert.equal(receipt.operatorBudgetEnabled, false);
  assert.equal(receipt.externalObjectsDeleted, false);
  assert.equal(receipt.publicIngressMayOpen, false);
  assert.deepEqual(receipt.admin, {
    username: "admin",
    role: "super_admin",
    mustChangePassword: true,
  });
  assert.equal(JSON.stringify(receipt).includes("PRIVATE-"), false);
  assert.deepEqual(await captureRestartRows(db, preservedNames), preserved);
  const afterPlan = await reset.plan({
    expectedUserCount: 1,
    maintenanceConfirmed: true,
  });
  for (const name of afterPlan.erasedTables.filter(
    (name) => !["users", "user_credentials", "audit_log"].includes(name),
  ))
    assert.equal(afterPlan.counts[name], 0, name);
  assert.equal(afterPlan.counts.users, 1);
  assert.equal(afterPlan.counts.user_credentials, 1);
  assert.equal(afterPlan.counts.audit_log, 1);
  const admin = await new AccountAccess(db).credentials("admin");
  assert.ok(admin);
  assert.equal(admin.password_hash, "PRIVATE-NEW-BOOTSTRAP-HASH");
  assert.equal(admin.role, "super_admin");
  assert.equal(admin.mustChangePassword, true);
  assert.ok(BigInt(admin.id) > BigInt(data.ids[1]!));
  assert.equal(
    await new AccountAccess(db).credentials("restart-owner@example.test"),
    undefined,
  );
  const budgetAfter = (await db.query("select * from ai_budget")).rows[0]!;
  assert.deepEqual(budgetAfter, {
    ...budgetBefore,
    enabled: false,
    total_reserved_micros: 0,
    user_daily_limit_micros: null,
    revision: Number(budgetBefore.revision) + 1,
  });
  const audit = (
    await db.query<{ payload: Record<string, unknown> }>(
      "select payload from audit_log",
    )
  ).rows[0]!;
  assert.equal(audit.payload.accountingPreserved, false);
  assert.equal(audit.payload.accountsDeleted, 2);
  const newUser = await new Repository(db).register(
    "fresh-user@example.test",
    "SYNTHETIC-HASH",
  );
  assert.ok(BigInt(newUser) > BigInt(admin.id));
});

test("fresh reset is one-time: old or newly pinned input cannot recreate known admin password", async (t) => {
  const { db, reset } = await fixture(t);
  const input = await prepared(reset);
  await reset.apply(input);
  const before = await captureRestartRows(db);
  await assert.rejects(reset.apply(input), /изменились/);
  const plan = await reset.plan({
    expectedUserCount: 1,
    maintenanceConfirmed: true,
  });
  assert.ok(
    plan.blockers.some(
      (blocker) => blocker.code === "FRESH_RESET_ALREADY_COMPLETED",
    ),
  );
  await assert.rejects(reset.apply(await prepared(reset, 1)), /заблокирован/);
  assert.deepEqual(await captureRestartRows(db), before);
});

test("full reset requires exact user count and all destructive operator attestations", async (t) => {
  const { db, reset } = await fixture(t);
  const before = await captureRestartRows(db);
  const unpinned = await reset.plan();
  assert.ok(
    unpinned.blockers.some(
      (blocker) => blocker.code === "EXPECTED_USER_COUNT_NOT_PINNED",
    ),
  );
  assert.ok(
    unpinned.blockers.some(
      (blocker) => blocker.code === "MAINTENANCE_NOT_CONFIRMED",
    ),
  );
  const input = await prepared(reset);
  for (const key of [
    "maintenanceConfirmed",
    "servicesStoppedConfirmed",
    "destructiveResetConfirmed",
  ] as const)
    await assert.rejects(
      reset.apply({ ...input, [key]: false } as unknown as typeof input),
      /Требуются/,
    );
  for (const key of [
    "expectedSnapshotFingerprint",
    "backupReceiptSha256",
  ] as const)
    await assert.rejects(
      reset.apply({ ...input, [key]: "not-a-fingerprint" }),
      /Требуются/,
    );
  await assert.rejects(
    reset.apply({ ...input, expectedUserCount: 1 }),
    /заблокирован/,
  );
  await assert.rejects(reset.plan({ expectedUserCount: 1001 }), /ограничен/);
  assert.deepEqual(await captureRestartRows(db), before);
});

for (const kind of ["message", "schema", "knowledge", "budget"] as const)
  test(`fresh reset rejects stale ${kind} snapshot without deleting anything`, async (t) => {
    const { db, reset } = await fixture(t);
    const input = await prepared(reset);
    if (kind === "message")
      await db.exec("update messages set content='PRIVATE-EDIT'");
    if (kind === "schema")
      await db.exec(
        "create index synthetic_fresh_reset_idx on messages(content)",
      );
    if (kind === "knowledge")
      await db.exec("update knowledge_sources set title='PRIVATE-EDIT'");
    if (kind === "budget")
      await db.exec(
        "update ai_budget set total_limit_micros=total_limit_micros+1",
      );
    const before = await captureRestartRows(db);
    await assert.rejects(reset.apply(input), /изменились/);
    assert.deepEqual(await captureRestartRows(db), before);
  });

test("unknown table inventory fails closed, not dynamically cascaded", async (t) => {
  const { db, reset } = await fixture(t);
  await db.exec("create table unknown_private_table(value text)");
  await db.exec(
    "insert into unknown_private_table values ('PRIVATE-DO-NOT-DELETE')",
  );
  const before = await captureRestartRows(db);
  await assert.rejects(reset.plan(), /Состав таблиц/);
  assert.deepEqual(await captureRestartRows(db), before);
});

test("any new NPD obligation blocks full reset without erasing receipt history or delivery contact", async (t) => {
  const { db, data, reset } = await fixture(t);
  const stale = await prepared(reset);
  await seedRestartNpdObligation(db, data.user, true);
  const before = await captureRestartRows(db);
  const plan = await reset.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.equal(plan.counts.npd_receipt_tasks, 1);
  assert.equal(plan.counts.npd_receipt_commands, 2);
  assert.equal(plan.counts.npd_receipt_evidence, 1);
  assert.equal(plan.counts.npd_refund_observations, 1);
  assert.ok(
    plan.blockers.some(
      (blocker) => blocker.code === "NPD_RECEIPT_HISTORY_PRESENT",
    ),
  );
  for (const name of [
    "npd_receipt_tasks",
    "npd_receipt_commands",
    "npd_receipt_evidence",
    "npd_refund_observations",
  ]) {
    assert.equal(plan.erasedTables.includes(name), false);
    assert.equal(plan.preservedTables.includes(name), true);
  }
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-|@example\.test/);
  await assert.rejects(reset.apply(stale), /изменились/);
  await assert.rejects(reset.apply(await prepared(reset)), /заблокирован/);
  assert.deepEqual(await captureRestartRows(db), before);
});

for (const journal of [false, true])
  test(`refund ${journal ? "journal and events" : "allocation alone"} blocks full reset without financial erasure`, async (t) => {
    const { db, data, reset } = await fixture(t);
    await seedRestartRefundHistory(db, data.user, { journal });
    const before = await captureRestartRows(db);
    const plan = await reset.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.ok(
      plan.blockers.some(
        (blocker) => blocker.code === "REFUND_FINANCIAL_HISTORY_PRESENT",
      ),
    );
    assert.equal(plan.counts.credit_refund_allocations, 1);
    assert.equal(plan.counts.payment_refunds, journal ? 1 : 0);
    assert.equal(plan.counts.payment_refund_events, journal ? 1 : 0);
    for (const name of [
      "credit_refund_allocations",
      "payment_refunds",
      "payment_refund_events",
    ]) {
      assert.equal(plan.erasedTables.includes(name), false);
      assert.equal(plan.preservedTables.includes(name), true);
    }
    assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-|@example\.test/);
    await assert.rejects(reset.apply(await prepared(reset)), /заблокирован/);
    assert.deepEqual(await captureRestartRows(db), before);
  });

test("unreviewed materialized private history is not silently left behind", async (t) => {
  const { db, reset } = await fixture(t);
  await db.exec(
    "create materialized view synthetic_private_history as select content from messages",
  );
  await assert.rejects(reset.plan(), /непроверенное хранилище/);
  assert.equal(
    (await db.query("select content from synthetic_private_history")).rows
      .length,
    1,
  );
});

for (const processed of [false, true])
  test(`fresh reset retains ${processed ? "processed" : "pending"} payment notification evidence and refuses its erasure`, async (t) => {
    const { db, data, reset } = await fixture(t);
    const stale = await prepared(reset);
    await seedRestartPaymentNotification(db, data.user, { processed });
    const before = await captureRestartRows(db);
    const plan = await reset.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.equal(plan.counts.payment_notification_inbox, 1);
    assert.equal(
      plan.erasedTables.includes("payment_notification_inbox"),
      false,
    );
    assert.equal(
      plan.preservedTables.includes("payment_notification_inbox"),
      true,
    );
    assert.ok(
      plan.blockers.some(
        (blocker) =>
          blocker.code === "PAYMENT_NOTIFICATION_HISTORY_PRESENT" &&
          blocker.count === 1,
      ),
    );
    // This blocker does not merely piggyback on a receipt/refund obligation.
    assert.equal(plan.counts.npd_receipt_tasks, 0);
    assert.equal(plan.counts.payment_refunds, 0);
    assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-|@example\.test/);
    await assert.rejects(reset.apply(stale), /изменились/);
    await assert.rejects(reset.apply(await prepared(reset)), /заблокирован/);
    assert.deepEqual(await captureRestartRows(db), before);
  });

for (const active of ["request", "lease", "busy"] as const)
  test(`active ${active} blocks destructive reset despite permission to erase history`, async (t) => {
    const { db, reset } = await fixture(t);
    if (active === "request")
      await db.exec("update chat_requests set status='running'");
    if (active === "lease")
      await db.query("update agent_threads set lease_token=$1", [
        "a9474d46-bf24-4b6d-adfe-6a04ab3e21fe",
      ]);
    if (active === "busy")
      await db.exec(
        "update agent_threads set busy_until=now()+interval '1 hour'",
      );
    const before = await captureRestartRows(db);
    const plan = await reset.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.ok(
      plan.blockers.some(
        (blocker) =>
          blocker.code ===
          (active === "request"
            ? "ACTIVE_CHAT_REQUESTS"
            : "UNRELEASED_GENERATION_LEASES"),
      ),
    );
    await assert.rejects(reset.apply(await prepared(reset)), /заблокирован/);
    assert.deepEqual(await captureRestartRows(db), before);
  });

test("unresolved historical hold and missing provider receipt are intentionally erased under full reset authority", async (t) => {
  const { db, reset } = await fixture(t);
  await db.exec(
    "update ai_credit_charges set receipt=null,response_complete=false",
  );
  await db.exec("delete from ai_credit_entries where kind='settle'");
  await db.exec("update ai_credit_accounts set held_micros=1000000");
  const plan = await reset.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.deepEqual(plan.blockers, []);
  await reset.apply(await prepared(reset));
  assert.equal(
    (await db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});

test("failure after truncate rolls back old accounts, accounting, knowledge and bootstrap state", async (t) => {
  const { db, reset } = await fixture(t);
  await db.exec(`create function synthetic_fresh_fail() returns trigger language plpgsql as $$ begin raise exception 'Synthetic bootstrap failure'; end $$;
    create trigger synthetic_fresh_fail before insert on users for each row execute function synthetic_fresh_fail()`);
  const input = await prepared(reset),
    before = await captureRestartRows(db);
  await assert.rejects(reset.apply(input), /Synthetic bootstrap failure/);
  assert.deepEqual(await captureRestartRows(db), before);
});

test("deferred trigger cannot resurrect knowledge after final bootstrap and audit writes", async (t) => {
  const { db, reset } = await fixture(t);
  await db.exec(`create function synthetic_fresh_restore() returns trigger language plpgsql as $$ begin
      insert into knowledge_sources(slug,title) values ('resurrected','PRIVATE-RESURRECTED'); return new; end $$;
    create constraint trigger synthetic_fresh_restore after insert on audit_log deferrable initially deferred
      for each row execute function synthetic_fresh_restore()`);
  const input = await prepared(reset),
    before = await captureRestartRows(db);
  await assert.rejects(reset.apply(input), /История восстановлена/);
  assert.deepEqual(await captureRestartRows(db), before);
});

test("unexpected bootstrap trigger changing preserved routing rolls back entire reset", async (t) => {
  const { db, reset } = await fixture(t);
  await db.exec(`create function synthetic_fresh_routing() returns trigger language plpgsql as $$ begin
      update ai_routing set revision=revision+1; return new; end $$;
    create trigger synthetic_fresh_routing after insert on users for each row execute function synthetic_fresh_routing()`);
  const input = await prepared(reset),
    before = await captureRestartRows(db);
  await assert.rejects(reset.apply(input), /конфигурация изменились/);
  assert.deepEqual(await captureRestartRows(db), before);
});

for (const kind of [
  "owner",
  "continuous",
  "reconciliation",
  "run",
  "command",
  "event",
] as const)
  test(`fresh reset refuses ${kind} admission state/history without deleting or unlinking it`, async (t) => {
    const { db, data, reset } = await fixture(t);
    const stale = await prepared(reset);
    if (kind === "owner")
      await db.query("update payment_admission set owner_user_id=$1", [
        data.user,
      ]);
    if (kind === "continuous")
      await db.query(
        "update payment_admission set owner_user_id=$1,merchant_id='123456',runtime_policy_id=repeat('a',64),mode='continuous',accepting_new_checkouts=true,manual_npd_responsibility_accepted=true",
        [data.user],
      );
    if (kind === "reconciliation")
      await db.exec(
        "update payment_admission set merchant_id='123456',runtime_policy_id=repeat('a',64),reconciliation_enabled=true",
      );
    if (kind === "run")
      await db.exec(
        "update payment_admission set reconciliation_run_id='0af9b212-c46b-42df-b923-e57d639b620b',reconciliation_run_revision=1,reconciliation_run_until=clock_timestamp()-interval '1 hour'",
      );
    if (kind === "command")
      await db.query(
        "insert into payment_admission_commands(request_id,actor_user_id,merchant_id,runtime_policy_id,payload,result_revision,result) values('58b8a462-17db-4ce8-b731-c7c6bec3e091',$1,'123456',repeat('a',64),'{\"action\":\"close\"}',2,'{}')",
        [data.user],
      );
    if (kind === "event")
      await db.exec(
        "insert into payment_admission_reconciliation_events(run_id,admission_revision,merchant_id,runtime_policy_id,success) values('0af9b212-c46b-42df-b923-e57d639b620b',1,'123456',repeat('a',64),false)",
      );
    const before = await captureRestartRows(db);
    const plan = await reset.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.ok(
      plan.blockers.some(
        (item) =>
          item.code ===
          (kind === "command" || kind === "event"
            ? "PAYMENT_ADMISSION_HISTORY_PRESENT"
            : "PAYMENT_ADMISSION_LINKED_OR_ACTIVE"),
      ),
    );
    for (const name of [
      "payment_admission",
      "payment_admission_commands",
      "payment_admission_reconciliation_events",
    ]) {
      assert.equal(plan.erasedTables.includes(name), false);
      assert.equal(plan.preservedTables.includes(name), true);
    }
    assert.notEqual(
      plan.snapshotFingerprint,
      stale.expectedSnapshotFingerprint,
    );
    await assert.rejects(reset.apply(stale), /изменились/);
    await assert.rejects(reset.apply(await prepared(reset)), /заблокирован/);
    assert.deepEqual(await captureRestartRows(db), before);
  });

for (const effect of ["failure", "admission", "knowledge"] as const)
  test(`fresh reset user DELETE ${effect} trigger rolls back child erasure and preserves admission`, async (t) => {
    const { db, reset } = await fixture(t);
    const body =
      effect === "failure"
        ? "raise exception 'Synthetic user DELETE failure';"
        : effect === "admission"
          ? "update payment_admission set revision=revision+1;"
          : "insert into knowledge_sources(slug,title) values ('resurrected-'||old.id::text,'PRIVATE-RESURRECTED');";
    await db.exec(`create function synthetic_fresh_user_delete() returns trigger language plpgsql as $$ begin ${body} return old; end $$;
      create trigger synthetic_fresh_user_delete before delete on users for each row execute function synthetic_fresh_user_delete()`);
    const input = await prepared(reset);
    const before = await captureRestartRows(db);
    await assert.rejects(
      reset.apply(input),
      effect === "failure"
        ? /Synthetic user DELETE failure/
        : effect === "admission"
          ? /конфигурация изменились/
          : /История восстановлена/,
    );
    assert.deepEqual(await captureRestartRows(db), before);
  });

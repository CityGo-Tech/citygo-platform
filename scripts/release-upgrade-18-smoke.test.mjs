import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { root } from "./env.mjs";
import {
  closedPaymentAdmissionSql,
  paymentAdmissionAclSql,
} from "./payment-admission-smoke.mjs";
import {
  releaseUpgrade18Smoke,
  upgrade18CleanupSql,
  upgrade18RewindSql,
  upgrade18SeedSql,
} from "./release-upgrade-18-smoke.mjs";

// Embedded PG executes the same literal fixture SQL, without network/database
// credentials. The Docker rehearsal separately proves the restricted migrator.
const dbRequire = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { PGlite } = await import(
  pathToFileURL(dbRequire.resolve("@electric-sql/pglite")).href
);
const migrationDirectory = join(root, "packages/db/migrations");
const migrations = readdirSync(migrationDirectory)
  .sort()
  .map((name) => {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    return {
      name,
      sql,
      checksum: createHash("sha256")
        .update(sql.replaceAll("\r\n", "\n"))
        .digest("hex"),
    };
  });
const withoutTransaction = (sql) =>
  sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, "");

test("18→45 rehearsal rejects a production project before fixture I/O", async () => {
  const unexpected = () => assert.fail("No I/O before ownership guards");
  await assert.rejects(
    releaseUpgrade18Smoke({
      project: "citygo-production",
      directory: "not-a-disposable-fixture",
      compose: unexpected,
      docker: unexpected,
      psql: unexpected,
    }),
    /citygo-pilot-test/,
  );
});

test("literal schema-18 fixture preserves budgets/orders/holds, rolls back late ACLs and reapplies only 19–45", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  assert.equal(migrations.length, 45);
  assert.equal(migrations[17].name, "0018_payment_refunds.sql");
  assert.deepEqual(
    migrations.slice(18).map(({ name }) => name),
    [
      "0019_yookassa_live_orders.sql",
      "0020_ai_budget_provider_balance.sql",
      "0021_payment_notifications.sql",
      "0022_payment_admission.sql",
      "0023_payment_receipt_snapshots.sql",
      "0024_ai_credit_overdraft.sql",
      "0025_assistant_conversations.sql",
      "0026_email_registration.sql",
      "0027_phone_verification.sql",
      "0028_password_recovery.sql",
      "0029_personal_plan.sql",
      "0030_service_consents.sql",
      "0031_account_email_confirmation.sql",
      "0032_phone_contact_bindings.sql",
      "0033_ai_request_modes.sql",
      "0034_gigachat_request_fees.sql",
      "0035_ai_request_consent_bases.sql",
      "0036_protected_phone_contacts.sql",
      "0037_human_support_requests.sql",
      "0038_manual_personal_plan.sql",
      "0039_plan_checklists.sql",
      "0040_human_support_replies.sql",
      "0041_personal_plan_history.sql",
      "0042_human_support_reads.sql",
      "0043_balance_history.sql",
      "0044_conversation_titles.sql",
      "0045_ai_balance_request_cost_limit.sql",
    ],
  );
  await db.exec(
    "create role citygo_api; create role citygo_worker; create role citygo_backup; create table citygo_migrations(name text primary key,checksum text not null)",
  );
  const apply = async (selected, fail = false) =>
    db.transaction(async (tx) => {
      for (const migration of selected) {
        await tx.exec(withoutTransaction(migration.sql));
        await tx.query(
          "insert into citygo_migrations(name,checksum) values($1,$2)",
          [migration.name, migration.checksum],
        );
      }
      const grants = readFileSync(
        join(root, "deploy/postgres/grants.sql"),
        "utf8",
      ).replace(/^\\set[^\n]*\n/gm, "");
      await tx.exec(withoutTransaction(grants));
      if (fail)
        await tx.exec(
          "grant select on public.upgrade18_intentionally_missing to citygo_api",
        );
    });
  await apply(migrations);
  const defaultBudget = (await db.query("select * from ai_budget")).rows;
  const confirmationUser = (
    await db.query(
      "insert into users(auth_subject) values('upgrade18-confirmation-canary') returning id",
    )
  ).rows[0].id;
  await db.query(
    `insert into account_email_confirmation_challenges
     (id,user_id,email,credential_digest,session_token_hash,proof_hash,code_hash,recipient_key,expires_at)
     values('00000000-0000-4000-8000-000000180031',$1,'upgrade18@example.test',$2,$2,$2,$2,$2,clock_timestamp()+interval '10 minutes')`,
    [confirmationUser, "cd".repeat(32)],
  );
  await assert.rejects(
    db.exec(upgrade18RewindSql()),
    /Account email confirmation history cannot be rewound/,
  );
  await db.exec("rollback");
  assert.deepEqual(
    (
      await db.query(`select
      (select count(*)::int from account_email_confirmation_challenges) as confirmation,
      (select count(*)::int from citygo_migrations) as migrations,
      to_regclass('payment_admission') is not null as admission,
      exists(select 1 from pg_proc where proname='citygo_guard_account_email_verification_proof') as guard`)
    ).rows,
    [{ confirmation: 1, migrations: 45, admission: true, guard: true }],
  );
  await db.query("delete from account_email_confirmation_challenges");
  await db.query("delete from users where id=$1", [confirmationUser]);
  const recoveryId = "00000000-0000-4000-8000-000000180028";
  await db.query(
    "insert into password_recovery_challenges(id,proof_hash,code_hash,recipient_key,expires_at) values($1,$2,$2,$2,clock_timestamp()+interval '10 minutes')",
    [recoveryId, "ab".repeat(32)],
  );
  await assert.rejects(
    db.exec(upgrade18RewindSql()),
    /Password recovery history cannot be rewound/,
  );
  await db.exec("rollback");
  assert.deepEqual(
    (
      await db.query(`select
      (select count(*)::int from password_recovery_challenges where id='${recoveryId}') as recovery,
      (select count(*)::int from citygo_migrations) as migrations,
      to_regclass('payment_admission') is not null as admission,
      exists(select 1 from pg_proc where proname='citygo_guard_password_recovery') as guard`)
    ).rows,
    [{ recovery: 1, migrations: 45, admission: true, guard: true }],
    "Rejected rewind retains recovery history and rolls back earlier DDL",
  );
  // Remove only this synthetic in-memory test row before the existing empty
  // fixture rehearsal; runtime and release helpers never erase recovery history.
  await db.query("delete from password_recovery_challenges where id=$1", [
    recoveryId,
  ]);
  await db.exec(upgrade18RewindSql());
  assert.deepEqual(
    (
      await db.query(
        "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='agent_threads' and column_name='conversation_agent_key') as assistant_column,to_regclass('one_open_thread_per_assistant')::text as assistant_index",
      )
    ).rows,
    [{ assistant_column: false, assistant_index: null }],
    "Rewind removes actual 0025 structures, not merely its journal entry",
  );
  assert.deepEqual(
    (
      await db.query(
        "select to_regclass('credit_charge_debts')::text as debts,to_regclass('credit_debt_repayments')::text as repayments,exists(select 1 from information_schema.columns where table_schema='public' and table_name='ai_credit_charges' and column_name='reservation_mode') as overdraft,exists(select 1 from pg_constraint where conrelid='ai_credit_accounts'::regclass and conname='ai_credit_accounts_check') as fully_prepaid",
      )
    ).rows,
    [{ debts: null, repayments: null, overdraft: false, fully_prepaid: true }],
    "Schema18 is truly fully prepaid, not merely a truncated migration journal",
  );
  const journal = async () =>
    (
      await db.query(
        'select name,checksum from citygo_migrations order by name collate "C"',
      )
    ).rows;
  const prefix = migrations
    .slice(0, 18)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.deepEqual(await journal(), prefix);
  assert.deepEqual(
    (
      await db.query(
        "select to_regclass('payment_notification_inbox')::text as relation,exists(select 1 from information_schema.columns where table_schema='public' and table_name='ai_budget' and column_name='mode') as mode,exists(select 1 from pg_constraint where conrelid='payment_topup_orders'::regclass and conname='payment_topup_orders_test_check') as test_only",
      )
    ).rows,
    [{ relation: null, mode: false, test_only: true }],
  );
  const oldIsolation = (
    await db.query(
      "select prosrc,proconfig from pg_proc where proname='citygo_mark_payment_isolation'",
    )
  ).rows[0];
  assert.match(
    oldIsolation.prosrc,
    /TG_TABLE_NAME='payment_topup_orders' then wanted_test=true/,
  );
  assert.equal(oldIsolation.proconfig, null);
  await db.exec(upgrade18SeedSql);
  const history = async () =>
    (
      await db.query(`select jsonb_build_object(
      'users',(select jsonb_agg(to_jsonb(t) order by id) from users t),
      'credentials',(select jsonb_agg(to_jsonb(t) order by user_id) from user_credentials t),
      'threads',(select jsonb_agg(to_jsonb(t)-'conversation_agent_key' order by id) from agent_threads t),
      'messages',(select jsonb_agg(to_jsonb(t) order by id) from messages t),
      'accounts',(select jsonb_agg(to_jsonb(t) order by user_id) from ai_credit_accounts t),
      'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t),
      'lots',(select jsonb_agg(to_jsonb(t) order by id) from credit_source_lots t),
      'holds',(select jsonb_agg(to_jsonb(t) order by hold_id) from credit_hold_allocations t),
      'orders',(select jsonb_agg(to_jsonb(t)-'payload_version'-'receipt_email'-'receipt_profile' order by id) from payment_topup_orders t),
      'isolation',(select jsonb_agg(to_jsonb(t) order by id) from account_security_state t),
      'budget',(select jsonb_agg(to_jsonb(t)-'mode' order by id) from ai_budget t),
      'daily',(select jsonb_agg(to_jsonb(t) order by usage_day) from ai_budget_daily t)) as snapshot`)
    ).rows[0].snapshot;
  const schema = async () =>
    (
      await db.query(`select jsonb_build_object(
      'columns',(select jsonb_agg(to_jsonb(t) order by table_name,ordinal_position)
        from information_schema.columns t where table_schema='public'),
      'constraints',(select jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.oid)
        from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'),
      'acls',(select jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text) order by c.relname)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
      'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) order by p.oid)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')) as snapshot`)
    ).rows[0].snapshot;
  const historyBefore = await history();
  const schemaBefore = await schema();
  assert.deepEqual(
    (
      await db.query(
        "select enabled,total_reserved_micros::text,user_daily_limit_micros::text from ai_budget",
      )
    ).rows,
    [
      {
        enabled: false,
        total_reserved_micros: "25000000",
        user_daily_limit_micros: "50000000",
      },
    ],
  );
  await assert.rejects(
    apply(migrations.slice(18), true),
    /upgrade18_intentionally_missing/,
  );
  assert.deepEqual(await journal(), prefix);
  assert.deepEqual(
    await schema(),
    schemaBefore,
    "Last failing ACL restores columns, constraints, isolation function and earlier grants",
  );
  assert.deepEqual(await history(), historyBefore);

  await apply(migrations.slice(18));
  assert.deepEqual(
    (
      await db.query(
        "select conversation_agent_key from agent_threads where user_id=900018",
      )
    ).rows,
    [{ conversation_agent_key: null }],
    "Existing historical thread is explicitly kept as legacy",
  );
  assert.deepEqual(
    await journal(),
    migrations.map(({ name, checksum }) => ({ name, checksum })),
  );
  assert.deepEqual(await history(), historyBefore);
  assert.deepEqual(
    (await db.query("select mode,enabled from ai_budget")).rows,
    [{ mode: "fixed", enabled: false }],
  );
  assert.equal(
    (await db.query(closedPaymentAdmissionSql)).rows[0]["?column?"],
    true,
  );
  assert.equal(
    (await db.query(paymentAdmissionAclSql)).rows[0]["?column?"],
    true,
  );
  assert.deepEqual(
    (
      await db.query(
        "select exists(select 1 from pg_constraint where conrelid='payment_topup_orders'::regclass and conname='payment_topup_orders_test_check') as test_only",
      )
    ).rows,
    [{ test_only: false }],
  );
  assert.deepEqual(
    (
      await db.query(
        "select payload_version,receipt_email,receipt_profile,create_payload?'receipt' as has_receipt from payment_topup_orders order by id",
      )
    ).rows,
    [
      {
        payload_version: 1,
        receipt_email: null,
        receipt_profile: null,
        has_receipt: false,
      },
    ],
    "Migration23 must not retrofit an existing receipt-free request",
  );
  assert.deepEqual(
    (
      await db.query(`select has_table_privilege('citygo_api','payment_notification_inbox','SELECT') as can_read,
      has_table_privilege('citygo_api','payment_notification_inbox','INSERT') as can_enqueue,
      has_column_privilege('citygo_api','payment_notification_inbox','status','UPDATE') as can_claim,
      has_column_privilege('citygo_api','payment_notification_inbox','object_id','UPDATE') as can_rewrite,
      has_table_privilege('citygo_api','payment_notification_inbox','DELETE') as can_delete,
      has_table_privilege('citygo_worker','payment_notification_inbox','SELECT') as worker_read,
      has_table_privilege('citygo_backup','payment_notification_inbox','SELECT') as backup_read`)
    ).rows,
    [
      {
        can_read: true,
        can_enqueue: true,
        can_claim: true,
        can_rewrite: false,
        can_delete: false,
        worker_read: false,
        backup_read: true,
      },
    ],
  );
  // A test order remains quarantined after the live-order migration; allowing
  // a live shape is not permission to mix sandbox money with real AI/checkout.
  await assert.rejects(
    db.exec(`insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload)
      values('00000000-0000-4000-8000-000000180099',900018,'00000000-0000-4000-8000-000000180098',10000,'123456',false,'https://pilot.example.test','{}')`),
    /Test payments and real AI cannot share a database/,
  );
  assert.deepEqual(await history(), historyBefore);
  await db.exec(upgrade18CleanupSql);
  assert.deepEqual(
    (await db.query("select * from ai_budget")).rows,
    defaultBudget,
  );
  assert.deepEqual(
    (
      await db.query(`select (select count(*)::int from users) as users,
      (select count(*)::int from payment_topup_orders) as orders,
      (select count(*)::int from credit_source_lots) as lots,
      (select count(*)::int from credit_hold_allocations) as holds,
      (select count(*)::int from ai_credit_entries) as entries,
      (select count(*)::int from ai_budget_daily) as daily,
      (select count(*)::int from payment_notification_inbox) as inbox,
      (select test_payments_seen or real_ai_admitted or bootstrap_completed from account_security_state where id=1) as admitted`)
    ).rows,
    [
      {
        users: 0,
        orders: 0,
        lots: 0,
        holds: 0,
        entries: 0,
        daily: 0,
        inbox: 0,
        admitted: false,
      },
    ],
  );
  assert.deepEqual(
    await journal(),
    migrations.map(({ name, checksum }) => ({ name, checksum })),
  );
});

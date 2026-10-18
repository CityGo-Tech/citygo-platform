// Synthetic pilot DB only, BEFORE any API/Worker starts. Never import on a host.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { root, serviceEnv } from "./env.mjs";
import {
  assertClosedPaymentAdmission,
  assertPaymentAdmissionAcls,
} from "./payment-admission-smoke.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function releaseMigrationSmoke({
  project,
  directory,
  compose,
  docker,
  psql,
}) {
  assert.match(project, /^citygo-pilot-test-[a-f0-9]{12}$/);
  const migrationDir = join(root, "packages/db/migrations");
  const migrations = readdirSync(migrationDir)
    .sort()
    .map((name) => ({
      name,
      sha256: digest(readFileSync(join(migrationDir, name))),
    }));
  assert.equal(
    migrations.length,
    22,
    "Update the disposable upgrade fixture when migrations change",
  );
  const last = migrations.at(-1);
  assert.equal(last.name, "0022_payment_admission.sql");
  const plan = {
    version: 1,
    kind: "citygo-release-migration",
    operationId: randomUUID(),
    targetSha: "a".repeat(40),
    currentMigrations: migrations.slice(0, 9),
    targetMigrations: migrations,
    grantsSha256: digest(
      readFileSync(join(root, "deploy/postgres/grants.sql")),
    ),
  };
  const run = (request = plan, { fail = false, mounts = [] } = {}) => {
    const output = compose(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        ...mounts.flatMap((mount) => ["-v", mount]),
        "migrator",
        "migrate-release",
      ],
      { input: JSON.stringify(request), fail, timeout: 170000 },
    );
    if (fail) {
      assert.equal(
        output.trim(),
        "",
        "A failed migration cannot print a success receipt",
      );
      return;
    }
    const result = JSON.parse(output);
    assert.equal(result.committed, true);
    assert.equal(result.trafficAuthorized, false);
    assert.equal(result.operationId, request.operationId);
    assert.equal(result.requestSha256, digest(JSON.stringify(request)));
    return result;
  };
  const assertOld = () => {
    assert.equal(psql("select count(*) from citygo_migrations"), "9");
    assert.equal(
      psql(
        "select count(*) from information_schema.tables where table_schema='public' and table_name in ('credit_source_lots','credit_hold_allocations','credit_refund_allocations','payment_refunds','payment_refund_events')",
      ),
      "0",
      "Failed release must roll back source reservations and monetary refund journal",
    );
    assert.equal(
      psql(
        "select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('citygo_guard_credit_source_lot','citygo_create_credit_gift_lot','citygo_create_credit_paid_lot','citygo_guard_credit_allocation','guard_payment_refund_identity','guard_payment_refund_event_immutable')",
      ),
      "0",
      "Failed release must not leave financial guard functions behind",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.tables where table_schema='public' and table_name in ('npd_receipt_tasks','npd_receipt_commands','npd_receipt_evidence','npd_refund_observations')",
      ),
      "0",
      "Failed release must roll back the entire NPD receipt registry",
    );
    assert.equal(
      psql(
        "select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('citygo_guard_npd_receipt_task','citygo_create_npd_receipt_task','citygo_apply_npd_refund_observation')",
      ),
      "0",
      "Failed release must not leave NPD trigger functions behind",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.tables where table_schema='public' and table_name in ('r1_housing_briefs','r1_housing_commands','r1_housing_brief_revisions')",
      ),
      "0",
      "Failed release must roll back every CG-012A table",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.tables where table_schema='public' and table_name='account_security_state'",
      ),
      "0",
      "Failed release must roll back the account-security table",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.columns where table_schema='public' and table_name='users' and column_name in ('username','role','must_change_password')",
      ),
      "0",
      "Failed release must roll back account-role columns too",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.columns where table_schema='public' and table_name='user_quests' and column_name='plan_id'",
      ),
      "0",
    );
    assert.equal(
      psql("select has_table_privilege('citygo_api','users','SELECT')"),
      "t",
    );
  };
  // Rewind ONLY the newly created synthetic fixture, not production rollback code.
  assert.equal(
    psql("select count(*) from users"),
    "0",
    "Never rewind a populated deployment",
  );
  psql(
    `begin;
     drop table payment_admission_commands,payment_admission_reconciliation_events,payment_admission;
     drop function citygo_guard_payment_admission_history();
     drop table payment_notification_inbox;
     drop function citygo_guard_payment_notification();
     alter table ai_budget drop constraint ai_budget_mode_limits,
       drop constraint ai_budget_enabled_rule, drop constraint ai_budget_reserved_safe_integer,
       drop column mode,
       alter column daily_limit_micros set not null,
       alter column total_limit_micros set not null,
       add constraint ai_budget_check check(daily_limit_micros <= total_limit_micros),
       add constraint ai_budget_check1 check(total_reserved_micros <= total_limit_micros),
       add constraint ai_budget_check2 check(not enabled or (currency is not null and daily_limit_micros>0 and jsonb_array_length(rules)>0)),
       add constraint ai_budget_total_reserved_micros_check check(total_reserved_micros between 0 and 1000000000000);
     alter table ai_budget_daily drop constraint ai_budget_daily_reserved_safe_integer,
       add constraint ai_budget_daily_reserved_micros_check check(reserved_micros between 0 and 1000000000000);
     drop table payment_refund_events,payment_refunds;
     drop function guard_payment_refund_identity();
     drop function guard_payment_refund_event_immutable();
     drop trigger credit_gift_lot on ai_credit_entries;
     drop trigger credit_paid_lot on ai_credit_topups;
     drop table credit_hold_allocations,credit_refund_allocations,credit_source_lots;
     drop function citygo_guard_credit_source_lot();
     drop function citygo_create_credit_gift_lot();
     drop function citygo_create_credit_paid_lot();
     drop function citygo_guard_credit_allocation();
     alter table ai_credit_accounts drop column billing_review_required;
     drop trigger npd_live_topup_obligation on ai_credit_topups;
     drop table npd_receipt_commands,npd_receipt_evidence,npd_refund_observations,npd_receipt_tasks;
     drop function citygo_guard_npd_receipt_task();
     drop function citygo_create_npd_receipt_task();
     drop function citygo_apply_npd_refund_observation();
     drop trigger payment_isolation_sticky on account_security_state;
     drop trigger payment_topup_isolation on ai_credit_topups;
     drop trigger real_ai_isolation on ai_model_attempts;
     drop table payment_topup_orders;
     drop function citygo_guard_payment_topup_order();
     drop function citygo_keep_payment_isolation();
     drop function citygo_mark_payment_isolation();
     alter table account_security_state drop column test_payments_seen, drop column real_ai_admitted;
     drop table ai_credit_topups;
     drop index ai_credit_entry_topup_identity;
     alter table ai_credit_charges drop column tariff_snapshot, drop column real_ceiling_micros;
     alter table ai_credit_accounts drop constraint ai_credit_accounts_granted_micros_check,
       add constraint ai_credit_accounts_granted_micros_check check (granted_micros in (0,500000000));
     alter table ai_credit_entries drop constraint ai_credit_entries_kind_check,
       drop constraint ai_credit_entries_amount_micros_check, drop constraint ai_credit_entries_check;
     alter table ai_credit_entries add constraint ai_credit_entries_kind_check check (kind in ('bonus','hold','settle','release')),
       add constraint ai_credit_entries_amount_micros_check check (amount_micros between 0 and 500000000),
       add constraint ai_credit_entries_check check (
         (kind='bonus' and amount_micros=500000000 and hold_id is null and actor_user_id is not null)
         or (kind='hold' and amount_micros>0 and hold_id is null and actor_user_id is null)
         or (kind in ('settle','release') and hold_id is not null and actor_user_id is null));
     drop table account_security_state;
     alter table users drop column username, drop column role, drop column must_change_password;
     drop table r1_housing_brief_revisions, r1_housing_commands, r1_housing_briefs;
     drop function citygo_keep_housing_history();
     drop trigger user_quests_keep_identity on user_quests;
     drop function citygo_keep_quest_identity();
     drop index relocation_plans_one_active;
     drop view citygo_quest_plan_preflight;
     alter table user_quests add constraint user_quests_user_id_quest_id_key unique(user_id,quest_id);
     alter table user_quests drop column plan_id, drop column plan_version;
     alter table relocation_plans drop constraint relocation_plans_owner_version_key;
     delete from citygo_migrations where name in ('0010_quest_plan_expand.sql','0011_quest_plan_validate.sql','0012_housing_answer_history.sql','0013_account_access.sql','0014_citygo_credit.sql','0015_yookassa_orders.sql','0016_npd_receipts.sql','0017_credit_source_lots.sql','0018_payment_refunds.sql','0019_yookassa_live_orders.sql','0020_ai_budget_provider_balance.sql','0021_payment_notifications.sql','0022_payment_admission.sql');
     commit`,
  );
  // A populated OLD-schema fixture, not just empty-table DDL. Explicit user ID
  // leaves the later pilot registration sequence alone; clean it up at the end.
  psql(`begin;
    insert into users(id,auth_subject) overriding system value values (900009,'cg009-release-fixture');
    insert into relocation_plans(user_id,status,plan,created_at,updated_at)
      values (900009,'active','{"stages":["housing-brief","housing-viewing"]}','2026-01-01','2026-01-01');
    insert into user_quests(user_id,quest_id,state,started_at,completed_at,created_at,updated_at)
      select 900009,id,case when slug='housing-brief' then 'completed' else 'locked' end,
        case when slug='housing-brief' then '2026-01-02'::timestamptz end,
        case when slug='housing-brief' then '2026-01-03'::timestamptz end,'2026-01-01','2026-01-03' from quests;
    insert into xp_events(user_id,user_quest_id,event_key,points,created_at)
      select 900009,uq.id,'quest-complete:'||uq.id::text,60,'2026-01-03' from user_quests uq where uq.user_id=900009 and state='completed';
    insert into ai_consents(user_id,policy_id,granted) values (900009,repeat('a',64),true);
    insert into ai_credit_accounts(user_id,granted_micros) values (900009,500000000);
    insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id)
      values (900009,'00000000-0000-4000-8000-000000900009','bonus',500000000,900009);
    commit`);
  const legacySnapshot = () =>
    psql(`select jsonb_build_object(
    'quests',(select jsonb_agg(to_jsonb(q)-'plan_id'-'plan_version' order by q.id) from user_quests q where user_id=900009),
    'xp',(select jsonb_agg(to_jsonb(x) order by x.id) from xp_events x where user_id=900009),
    'consent',(select to_jsonb(c) from ai_consents c where user_id=900009),
    'credit',(select to_jsonb(c)-'billing_review_required' from ai_credit_accounts c where user_id=900009),
    'ledger',(select jsonb_agg(to_jsonb(e) order by e.id) from ai_credit_entries e where user_id=900009))::text`);
  const before = legacySnapshot();
  assertOld();
  run({ ...plan, grantsSha256: "f".repeat(64) }, { fail: true });
  run(
    {
      ...plan,
      targetMigrations: [
        ...migrations.slice(0, -1),
        { ...last, sha256: "f".repeat(64) },
      ],
    },
    { fail: true },
  );
  psql(
    "insert into citygo_migrations(name,checksum) values ('9999_unexpected.sql','synthetic')",
  );
  run(plan, { fail: true });
  psql("delete from citygo_migrations where name='9999_unexpected.sql'");
  const saved = psql(
    "select checksum from citygo_migrations where name='0003_ai_access.sql'",
  );
  assert.match(saved, /^[a-f0-9]{64}$/);
  psql(
    "update citygo_migrations set checksum='synthetic-changed' where name='0003_ai_access.sql'",
  );
  run(plan, { fail: true });
  psql("delete from citygo_migrations where name='0003_ai_access.sql'");
  run(plan, { fail: true });
  psql(
    `insert into citygo_migrations(name,checksum) values ('0003_ai_access.sql','${saved}')`,
  );
  assertOld();
  // Fail AFTER real DDL, and separately AFTER revoking an existing permission.
  // Both the schema/ledger and ACL change must roll back together.
  const badGrants =
    "\\set ON_ERROR_STOP on\nbegin; revoke select on users from citygo_api; grant select on synthetic_missing_table to citygo_api; commit;\n";
  const grantsFile = join(directory, "synthetic-failing-grants.sql");
  writeFileSync(grantsFile, badGrants, { mode: 0o444 });
  // The migration path in the deployed pnpm package is resolved inside Node;
  // use a fixture-only bind over the resolved immutable SQL asset, never COPY it.
  const migrationPath = compose([
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--entrypoint",
    "node",
    "migrator",
    "--input-type=module",
    "-e",
    `import { fileURLToPath } from 'node:url'; console.log(fileURLToPath(new URL('../migrations/${last.name}', import.meta.resolve('@citygo/db'))));`,
  ]).trim();
  assert.match(
    migrationPath,
    /^\/app\/node_modules\/[a-zA-Z0-9_@./+-]+\/migrations\/0022_payment_admission\.sql$/,
  );
  const sqlFile = join(directory, "synthetic-failing-migration.sql");
  // Sequence increments survive rollback: prove the executor reached the SQL,
  // not merely a preflight/entrypoint failure that happened to leave the DB intact.
  psql("set role citygo_migrator; create sequence release_execution_probe");
  const probedMigration = readFileSync(
    join(migrationDir, last.name),
    "utf8",
  ).replace(
    /commit;\s*$/,
    "select pg_catalog.nextval('public.release_execution_probe'); commit;\n",
  );
  writeFileSync(sqlFile, probedMigration, { mode: 0o644 });
  run(
    {
      ...plan,
      grantsSha256: digest(badGrants),
      targetMigrations: [
        ...migrations.slice(0, -1),
        { ...last, sha256: digest(probedMigration) },
      ],
    },
    {
      fail: true,
      mounts: [
        `${grantsFile}:/app/release-grants.sql:ro`,
        `${sqlFile}:${migrationPath}:ro`,
      ],
    },
  );
  assert.equal(
    psql(
      "select last_value::text || ':' || is_called::text from release_execution_probe",
    ),
    "1:true",
  );
  assertOld();
  for (const body of [
    "begin; create table cg009_sql_probe(user_id bigint primary key); select pg_catalog.nextval('public.release_execution_probe'); select * from synthetic_missing_table; commit;\n",
    "begin; create table cg009_sql_probe(user_id bigint primary key); commit; begin; select * from synthetic_missing_table; commit;\n",
  ]) {
    writeFileSync(sqlFile, body, { mode: 0o644 });
    run(
      {
        ...plan,
        targetMigrations: [
          ...migrations.slice(0, -1),
          { ...last, sha256: digest(body) },
        ],
      },
      { fail: true, mounts: [`${sqlFile}:${migrationPath}:ro`] },
    );
    assert.equal(psql("select last_value from release_execution_probe"), "2");
    assertOld();
    assert.equal(
      psql(
        "select count(*) from information_schema.tables where table_schema='public' and table_name='cg009_sql_probe'",
      ),
      "0",
    );
  }
  psql("drop sequence release_execution_probe");
  // A concurrent old migrator fails NOWAIT; a schema lock fails lock_timeout.
  // Hold each real PostgreSQL lock until the attempted release has failed.
  for (const query of [
    "select id from citygo_migration_lock where id=1 for update",
    "lock table user_quests in access exclusive mode",
  ]) {
    const name = `${project}-migration-lock`;
    const script = `import {readFileSync} from 'node:fs'; import {connectDatabase} from '@citygo/db'; const db=await connectDatabase(JSON.parse(readFileSync('/run/secrets/migrate.json','utf8')).DATABASE_URL); let release; const stopped=new Promise(resolve=>release=resolve);process.once('SIGTERM',()=>release());const deadline=setTimeout(()=>release(),60000);try{await db.transaction(async tx=>{await tx.exec("set local idle_in_transaction_session_timeout='90s'");await tx.query(${JSON.stringify(query)});console.log('synthetic-lock-held');await stopped;});}finally{clearTimeout(deadline);await db.close();}`;
    const id = compose([
      "run",
      "-d",
      "--no-deps",
      "--name",
      name,
      "--entrypoint",
      "node",
      "migrator",
      "--input-type=module",
      "-e",
      script,
    ]).trim();
    assert.match(id, /^[a-f0-9]{64}$/);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (docker(["logs", id]).includes("synthetic-lock-held")) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, "Synthetic lock must be held before rejection test");
      run(plan, { fail: true });
      assertOld();
    } finally {
      // Killing a client in pg_sleep need not immediately release its server-side
      // lock. End the fixture transaction, confirm clean exit AND lock release.
      docker(["stop", "--time", "10", id]);
      assert.equal(
        docker(["inspect", "--format", "{{.State.ExitCode}}", id]).trim(),
        "0",
      );
      psql(
        "begin; select id from citygo_migration_lock where id=1 for update nowait; select id from ai_budget where id=1 for update nowait; rollback",
      );
      docker(["rm", id]);
    }
  }
  // Exercise the host-side retained-container transport for the actual upgrade.
  // Synthetic image approval/local S3 only; no production controller or GHCR.
  const configuration = JSON.parse(compose(["config", "--format", "json"]));
  const imageId = docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    configuration.services.migrator.image,
  ]).trim();
  const networkId = docker([
    "network",
    "inspect",
    "--format",
    "{{.Id}}",
    `${project}_database`,
  ]).trim();
  const fixture = join(directory, "migration-job-fixture.json");
  writeFileSync(
    fixture,
    JSON.stringify({
      project,
      image_id: imageId,
      network_id: networkId,
      compose: configuration,
      secret: join(directory, "migrate.json"),
      plan,
    }),
    { mode: 0o600 },
  );
  const execution = spawnSync(
    "python3",
    ["-B", "deploy/backup/migration_job_smoke.py", "--disposable", fixture],
    {
      cwd: root,
      env: serviceEnv("test"),
      encoding: "utf8",
      timeout: 420000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(execution.status, 0, execution.stderr);
  const proof = JSON.parse(execution.stdout);
  assert.equal(proof.ok, true);
  assert.equal(proof.containers.length, 2);
  for (const ident of proof.containers) {
    assert.match(ident, /^[a-f0-9]{64}$/);
    assert.equal(
      docker(["inspect", "--format", "{{.State.Status}}", ident]).trim(),
      "exited",
    );
    docker(["rm", ident]); // Exact disposable fixtures ONLY; runtime retains them.
  }
  assert.equal(psql("select count(*) from citygo_migrations"), "22");
  assertClosedPaymentAdmission(psql);
  assertPaymentAdmissionAcls(psql);
  assert.equal(
    psql(
      "select kind||':'||gross_micros::text||':'||spent_micros::text||':'||held_micros::text from credit_source_lots where user_id=900009",
    ),
    "legacy_nonrefundable:500000000:0:0",
    "Historical balance is conservatively migrated, not made refundable",
  );
  for (const table of [
    "credit_source_lots",
    "credit_hold_allocations",
    "credit_refund_allocations",
    "payment_refunds",
    "payment_refund_events",
  ]) {
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','SELECT') and has_table_privilege('citygo_api','${table}','INSERT') and has_table_privilege('citygo_backup','${table}','SELECT')`,
      ),
      "t",
    );
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','UPDATE') or has_table_privilege('citygo_api','${table}','DELETE') or has_table_privilege('citygo_api','${table}','TRUNCATE') or has_table_privilege('citygo_worker','${table}','SELECT')`,
      ),
      "f",
    );
  }
  for (const table of [
    "npd_receipt_tasks",
    "npd_receipt_commands",
    "npd_receipt_evidence",
    "npd_refund_observations",
  ]) {
    assert.equal(psql(`select count(*) from ${table}`), "0");
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','SELECT') and has_table_privilege('citygo_api','${table}','INSERT') and has_table_privilege('citygo_backup','${table}','SELECT')`,
      ),
      "t",
    );
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','DELETE') or has_table_privilege('citygo_api','${table}','TRUNCATE') or has_table_privilege('citygo_api','${table}','UPDATE') or has_table_privilege('citygo_worker','${table}','SELECT') or has_table_privilege('citygo_worker','${table}','INSERT')`,
      ),
      "f",
      "Receipt history has no broad UPDATE/delete/truncate or Worker access",
    );
  }
  assert.equal(
    psql(
      "select has_column_privilege('citygo_api','npd_receipt_tasks','revision','UPDATE') and has_column_privilege('citygo_api','sessions','expires_at','UPDATE') and not has_column_privilege('citygo_api','npd_receipt_tasks','buyer_email','UPDATE') and not has_column_privilege('citygo_api','npd_receipt_tasks','amount_kopeks','UPDATE')",
    ),
    "t",
    "Only reviewed task observations/session locking columns are writable",
  );
  assert.equal(
    psql(
      "select username is null and role='user' and not must_change_password from users where id=900009",
    ),
    "t",
    "An existing account is not silently promoted or made temporary",
  );
  assert.equal(
    psql("select bootstrap_completed from account_security_state where id=1"),
    "f",
    "Migration installs only state, never a known bootstrap account",
  );
  assert.equal(psql("select count(*) from users"), "1");
  for (const table of [
    "r1_housing_briefs",
    "r1_housing_commands",
    "r1_housing_brief_revisions",
  ]) {
    assert.equal(psql(`select count(*) from ${table}`), "0");
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','SELECT') or has_table_privilege('citygo_api','${table}','INSERT') or has_table_privilege('citygo_worker','${table}','SELECT')`,
      ),
      "f",
      "CG-012A storage is not a runtime feature activation",
    );
    assert.equal(
      psql(`select has_table_privilege('citygo_backup','${table}','SELECT')`),
      "t",
    );
  }
  assert.equal(
    legacySnapshot(),
    before,
    "CG-009 must preserve legacy progress, XP and AI money/consent",
  );
  assert.equal(
    psql(
      "select count(*) from user_quests uq join relocation_plans p on (p.id,p.user_id,p.version)=(uq.plan_id,uq.user_id,uq.plan_version) where uq.user_id=900009",
    ),
    "2",
  );
  assert.equal(
    psql(
      "select count(*) from citygo_quest_plan_preflight where issue is not null",
    ),
    "0",
  );
  assert.equal(
    psql(
      "select has_table_privilege('citygo_api','ai_credit_entries','UPDATE') or has_table_privilege('citygo_api','ai_credit_entries','DELETE') or has_table_privilege('citygo_api','ai_credit_charges','DELETE') or has_table_privilege('citygo_worker','ai_credit_accounts','SELECT') or has_table_privilege('citygo_worker','ai_credit_charges','SELECT')",
    ),
    "f",
  );
  assert.equal(
    psql(
      "select has_table_privilege('citygo_api','ai_credit_entries','INSERT') and has_table_privilege('citygo_api','ai_credit_accounts','UPDATE') and has_table_privilege('citygo_api','ai_credit_charges','INSERT') and has_table_privilege('citygo_api','ai_credit_charges','UPDATE') and has_table_privilege('citygo_backup','ai_credit_entries','SELECT') and has_table_privilege('citygo_backup','ai_credit_charges','SELECT')",
    ),
    "t",
  );
  assert.equal(
    psql(
      "select count(*) from information_schema.tables where table_schema='public' and table_name='ai_credit_charges'",
    ),
    "1",
  );
  run(plan, { fail: true }); // Committed upgrade is NOT retried from stale history.
  run({ ...plan, operationId: randomUUID(), currentMigrations: migrations }); // New release with no DDL.
  assert.equal(
    psql(
      "select has_table_privilege('citygo_api','citygo_migrations','UPDATE') or has_table_privilege('citygo_worker','users','SELECT')",
    ),
    "f",
  );
  console.log(
    "Guarded release migrations: real restricted-role upgrade, drift/lock/SQL/ACL failures, transactional rollback, no automatic retry or traffic opening",
  );
  // Remove ONLY the synthetic records created above, leaving subsequent pilot
  // tests and their first registration unchanged. No production cleanup helper.
  psql(
    "begin; delete from credit_hold_allocations where source_lot_id in (select id from credit_source_lots where user_id=900009); delete from credit_source_lots where user_id=900009; delete from ai_credit_entries where user_id=900009; delete from ai_credit_accounts where user_id=900009; delete from users where id=900009 and auth_subject='cg009-release-fixture'; commit",
  );
  assert.equal(psql("select count(*) from users"), "0");
}

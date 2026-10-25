// Synthetic-only 18→33 rehearsal for the disposable pilot harness, while its
// PostgreSQL container is the sole project member. Never a production rollback
// or migration tool; a successful receipt cannot authorize public traffic.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { root } from "./env.mjs";
import {
  assertClosedPaymentAdmission,
  assertPaymentAdmissionAcls,
} from "./payment-admission-smoke.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const userId = 900018;
const authSubject = "upgrade18-disposable-fixture";
const giftId = "00000000-0000-4000-8000-000000180001";
const holdId = "00000000-0000-4000-8000-000000180004";
const orderId = "00000000-0000-4000-8000-000000180005";

// Reuse the actual 0015 function, not an approximate reconstruction. The unit
// regression executes these same statements and verifies the historical shape.
export function upgrade18RewindSql() {
  const legacy = readFileSync(
    join(root, "packages/db/migrations/0015_yookassa_orders.sql"),
    "utf8",
  ).match(
    /create function citygo_mark_payment_isolation\(\) returns trigger[\s\S]*?\$\$;/,
  );
  assert.ok(legacy, "The historical isolation function must be available");
  const legacyFunction = legacy[0].replace(
    "create function",
    "create or replace function",
  );
  const legacyNpdFunctions = readFileSync(
    join(root, "packages/db/migrations/0016_npd_receipts.sql"),
    "utf8",
  ).match(
    /create function (?:citygo_guard_npd_receipt_task|citygo_create_npd_receipt_task)\(\) returns trigger[\s\S]*?\$\$;/g,
  );
  assert.equal(
    legacyNpdFunctions?.length,
    2,
    "Both original manual receipt functions must be available",
  );
  return `begin;
    drop table payment_admission_commands,payment_admission_reconciliation_events,payment_admission;
    drop function citygo_guard_payment_admission_history();
    do $$ begin
      if exists(select 1 from ai_request_modes) then
        raise exception 'AI request mode history cannot be rewound';
      end if;
    end $$;
    drop trigger ai_mode_attempt_guard on ai_model_attempts;
    drop function citygo_guard_ai_mode_attempt();
    drop table ai_request_modes;
    drop function citygo_guard_ai_request_mode();
    do $$ begin
      if exists(select 1 from phone_contact_bindings)
        or exists(select 1 from phone_contact_changes) then
        raise exception 'Phone contact history cannot be rewound';
      end if;
    end $$;
    drop table phone_contact_changes;
    drop table phone_contact_bindings;
    drop function citygo_guard_phone_contact_binding();
    drop function citygo_guard_phone_contact_change();
    drop function citygo_guard_phone_contact_completion();
    do $$ begin
      if exists(select 1 from account_email_confirmation_challenges)
        or exists(select 1 from account_email_verifications where confirmation_id is not null) then
        raise exception 'Account email confirmation history cannot be rewound';
      end if;
    end $$;
    drop trigger account_email_verification_proof on account_email_verifications;
    drop function citygo_guard_account_email_verification_proof();
    alter table account_email_verifications drop constraint account_email_verification_provenance,
      drop column confirmation_id;
    alter table account_email_verifications alter column registration_id set not null;
    drop table account_email_confirmation_challenges;
    drop function citygo_guard_account_email_confirmation();
    do $$ begin
      if exists(select 1 from service_consent_events)
        or exists(select 1 from email_registrations where consent_choice is not null) then
        raise exception 'Service consent history cannot be rewound';
      end if;
    end $$;
    drop table service_consent_events;
    drop function citygo_guard_service_consent_evidence();
    drop trigger email_registration_consent_identity on email_registrations;
    drop function citygo_guard_registration_consent();
    alter table email_registrations drop constraint email_registration_consent_snapshot,
      drop column consent_choice,drop column consent_policy,drop column consent_policy_hash,drop column consent_recorded_at;

    do $$ begin
      if exists(select 1 from personal_plan_items) then
        raise exception 'Personal plan history cannot be rewound';
      end if;
    end $$;
    drop table personal_plan_items;
    drop function citygo_guard_personal_plan_item();
    do $$ begin
      if exists(select 1 from password_recovery_challenges) then
        raise exception 'Password recovery history cannot be rewound';
      end if;
    end $$;
    drop table password_recovery_challenges;
    drop function citygo_guard_password_recovery();
    do $$ begin
      if exists(select 1 from phone_welcome_claims)
        or exists(select 1 from phone_verification_challenges)
        or exists(select 1 from phone_verification_sends)
        or exists(select 1 from phone_verification_control where identity_key_fingerprint is not null) then
        raise exception 'Phone verification history cannot be rewound';
      end if;
    end $$;
    drop table phone_welcome_claims,phone_verification_sends,phone_verification_challenges,phone_verification_control;
    drop function citygo_guard_phone_challenge(),citygo_guard_phone_welcome_claim();
    do $$ begin
      if exists(select 1 from account_email_verifications)
        or exists(select 1 from email_registrations)
        or exists(select 1 from email_registration_rate_events) then
        raise exception 'Email registration history cannot be rewound';
      end if;
    end $$;
    drop table account_email_verifications,email_registrations,email_registration_rate_events;
    drop function citygo_guard_email_registration();
    -- Remove 0025 only in this verified empty disposable fixture, then restore
    -- the genuine historical one-open-thread constraint before seeding.
    drop trigger assistant_conversation_identity on agent_threads;
    drop function citygo_guard_assistant_conversation();
    drop index one_open_thread_per_assistant;
    drop index agent_threads_owner_history;
    drop index one_open_thread_per_user;
    alter table agent_threads drop column conversation_agent_key;
    create unique index one_open_thread_per_user on agent_threads(user_id) where status<>'closed';
    -- Restore the genuine fully prepaid 18-era shape before seeding it.
    drop trigger credit_source_debt_repayment on credit_source_lots;
    drop trigger credit_source_debt_check on credit_source_lots;
    drop trigger ai_credit_charge_reservation_guard on ai_credit_charges;
    drop trigger credit_receipt_debt_check on ai_credit_charges;
    drop trigger credit_account_debt_check on ai_credit_accounts;
    drop table credit_debt_repayments,credit_charge_debts;
    drop function citygo_guard_credit_debt_identity();
    drop function citygo_guard_charge_reservation_mode();
    drop function citygo_apply_credit_debt_repayments(bigint);
    drop function citygo_repay_credit_debt_from_new_source();
    drop function citygo_check_credit_debt_conservation();
    alter table ai_credit_charges drop constraint ai_credit_fixed5_scope,drop column reservation_mode;
    alter table ai_credit_accounts drop constraint ai_credit_bounded_overdraft,
      add constraint ai_credit_accounts_check check(held_micros+spent_micros<=granted_micros);
    drop table payment_notification_inbox;
    drop function citygo_guard_payment_notification();
    drop trigger payment_topup_receipt_immutable on payment_topup_orders;
    drop trigger payment_refund_receipt_immutable on payment_refunds;
    drop trigger payment_refund_receipt_source on payment_refunds;
    drop function citygo_guard_payment_receipt_snapshot();
    drop function citygo_guard_refund_receipt_source();
    alter table payment_topup_orders drop constraint payment_topup_receipt_snapshot,
      drop column payload_version,drop column receipt_email,drop column receipt_profile;
    alter table payment_refunds drop constraint payment_refund_receipt_snapshot,
      drop column payload_version,drop column receipt_email,drop column receipt_profile;
    ${legacyNpdFunctions.map((sql) => sql.replace("create function", "create or replace function")).join("\n")}
    alter table ai_budget drop constraint ai_budget_mode_limits,
      drop constraint ai_budget_enabled_rule,drop constraint ai_budget_reserved_safe_integer,
      drop column mode,
      alter column daily_limit_micros set not null,
      alter column total_limit_micros set not null,
      add constraint ai_budget_check check(daily_limit_micros <= total_limit_micros),
      add constraint ai_budget_check1 check(total_reserved_micros <= total_limit_micros),
      add constraint ai_budget_check2 check(not enabled or (currency is not null and daily_limit_micros>0 and jsonb_array_length(rules)>0)),
      add constraint ai_budget_total_reserved_micros_check check(total_reserved_micros between 0 and 1000000000000);
    alter table ai_budget_daily drop constraint ai_budget_daily_reserved_safe_integer,
      add constraint ai_budget_daily_reserved_micros_check check(reserved_micros between 0 and 1000000000000);
    alter table payment_topup_orders add constraint payment_topup_orders_test_check check(test);
    ${legacyFunction}
    delete from citygo_migrations where name in (
      '0019_yookassa_live_orders.sql','0020_ai_budget_provider_balance.sql','0021_payment_notifications.sql','0022_payment_admission.sql','0023_payment_receipt_snapshots.sql','0024_ai_credit_overdraft.sql','0025_assistant_conversations.sql','0026_email_registration.sql','0027_phone_verification.sql','0028_password_recovery.sql','0029_personal_plan.sql','0030_service_consents.sql','0031_account_email_confirmation.sql','0032_phone_contact_bindings.sql','0033_ai_request_modes.sql');
    commit`;
}

// All values are deliberately synthetic and fixed. This is a pending sandbox
// order, not a provider payment/posting; no NPD duty or paid source is created.
export const upgrade18SeedSql = `begin;
  insert into users(id,auth_subject) overriding system value values(${userId},'${authSubject}');
  insert into user_credentials(user_id,email,password_hash)
    values(${userId},'upgrade18@example.test','synthetic-not-a-login-hash');
  insert into agent_threads(user_id,agent_key,context) values(${userId},'housing','{"synthetic":true}');
  insert into messages(thread_id,role,content)
    select id,'user','Синтетическая история на схеме 18' from agent_threads where user_id=${userId};
  insert into ai_credit_accounts(user_id,granted_micros,spent_micros,held_micros)
    values(${userId},500000000,25000000,75000000);
  insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id)
    values(${userId},'${giftId}','bonus',500000000,${userId});
  insert into ai_credit_entries(user_id,operation_id,kind,amount_micros)
    values(${userId},'00000000-0000-4000-8000-000000180002','hold',100000000);
  insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id)
    values(${userId},'00000000-0000-4000-8000-000000180003','settle',25000000,'00000000-0000-4000-8000-000000180002');
  insert into ai_credit_entries(user_id,operation_id,kind,amount_micros)
    values(${userId},'${holdId}','hold',75000000);
  update credit_source_lots set spent_micros=25000000,held_micros=75000000 where id='${giftId}';
  insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros)
    values('${holdId}','${giftId}',0,75000000);
  insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,
    return_url,create_payload,provider_payment_id,status)
    values('${orderId}',${userId},'00000000-0000-4000-8000-000000180006',10000,'123456',true,
      'https://pilot.example.test/profile/balance','{"synthetic":true}',
      '00000000-0000-4000-8000-000000180007','pending');
  update ai_budget set revision=18,enabled=false,currency='RUB',daily_limit_micros=100000000,
    total_limit_micros=300000000,total_reserved_micros=25000000,user_daily_limit_micros=50000000,
    rules='[{"synthetic":true}]' where id=1;
  insert into ai_budget_daily(usage_day,reserved_micros) values('2026-01-18',25000000);
  commit`;

export const upgrade18CleanupSql = `begin;
  delete from payment_topup_orders where id='${orderId}' and user_id=${userId};
  delete from credit_hold_allocations where hold_id='${holdId}' and source_lot_id='${giftId}';
  delete from credit_source_lots where id='${giftId}' and user_id=${userId};
  delete from ai_credit_entries where user_id=${userId};
  delete from ai_credit_accounts where user_id=${userId};
  delete from users where id=${userId} and auth_subject='${authSubject}';
  delete from ai_budget_daily where usage_day='2026-01-18';
  update ai_budget set revision=1,enabled=false,currency=null,daily_limit_micros=0,
    total_limit_micros=0,total_reserved_micros=0,user_daily_limit_micros=null,rules='[]',mode='fixed' where id=1;
  update account_security_state set test_payments_seen=false where id=1;
  commit`;

export async function releaseUpgrade18Smoke({
  project,
  directory,
  compose,
  docker,
  psql,
}) {
  assert.match(project, /^citygo-pilot-test-[a-f0-9]{12}$/);
  assert.match(basename(directory), /^citygo-pilot-test-[A-Za-z0-9_-]+$/);
  assert.equal(lstatSync(directory).isDirectory(), true);
  assert.equal(realpathSync(directory), resolve(directory));
  const assertOwnedFixture = () => {
    const ids = docker([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ])
      .trim()
      .split(/\s+/);
    assert.equal(ids.length, 1);
    assert.match(ids[0], /^[a-f0-9]{64}$/);
    const pg = JSON.parse(
      docker([
        "inspect",
        "--format",
        '{"Id":{{json .Id}},"Labels":{{json .Config.Labels}},"Running":{{json .State.Running}},"Mounts":{{json .Mounts}}}',
        ids[0],
      ]),
    );
    assert.equal(pg.Id, ids[0]);
    assert.equal(pg.Labels["com.docker.compose.project"], project);
    assert.equal(pg.Labels["com.docker.compose.service"], "postgres");
    assert.equal(pg.Running, true);
    const data = pg.Mounts.filter(
      (mount) => mount.Destination === "/var/lib/postgresql/data",
    );
    assert.equal(data.length, 1);
    assert.equal(data[0].Type, "volume");
    assert.equal(data[0].Name, `${project}_database`);
    const network = JSON.parse(
      docker([
        "network",
        "inspect",
        "--format",
        '{"Internal":{{json .Internal}},"Labels":{{json .Labels}},"Containers":{{json .Containers}}}',
        `${project}_database`,
      ]),
    );
    assert.equal(network.Internal, true);
    assert.equal(network.Labels["com.docker.compose.project"], project);
    assert.deepEqual(Object.keys(network.Containers), ids);
    assert.equal(psql("select current_database()"), "citygo_pilot");
    assert.equal(
      psql("select current_setting('server_version_num')::int/10000"),
      "17",
    );
  };
  assertOwnedFixture();
  const emptyTables = [
    "users",
    "ai_credit_entries",
    "ai_model_attempts",
    "ai_budget_daily",
    "payment_topup_orders",
    "ai_credit_topups",
    "payment_refunds",
    "npd_receipt_tasks",
    "payment_notification_inbox",
    "payment_admission_commands",
    "payment_admission_reconciliation_events",
  ];
  for (const table of emptyTables)
    assert.equal(psql(`select count(*) from ${table}`), "0");
  const defaultBudget = {
    id: 1,
    revision: 1,
    enabled: false,
    currency: null,
    daily_limit_micros: 0,
    total_limit_micros: 0,
    total_reserved_micros: 0,
    rules: [],
    user_daily_limit_micros: null,
    mode: "fixed",
  };
  const budget = () =>
    JSON.parse(psql("select to_jsonb(t)::text from ai_budget t where id=1"));
  assert.deepEqual(budget(), defaultBudget);
  assert.equal(
    psql(
      "select not test_payments_seen and not real_ai_admitted and not bootstrap_completed from account_security_state where id=1",
    ),
    "t",
  );

  const migrationDirectory = join(root, "packages/db/migrations");
  const migrations = readdirSync(migrationDirectory)
    .sort()
    .map((name) => ({
      name,
      sha256: digest(readFileSync(join(migrationDirectory, name))),
    }));
  assert.deepEqual(
    migrations.map(({ name }) => name),
    [
      "0001_initial.sql",
      "0002_vertical_slice.sql",
      "0003_ai_access.sql",
      "0004_ai_routing.sql",
      "0005_ai_attempts.sql",
      "0006_ai_budget.sql",
      "0007_ai_user_daily_budget.sql",
      "0008_ai_credit.sql",
      "0009_ai_credit_charges.sql",
      "0010_quest_plan_expand.sql",
      "0011_quest_plan_validate.sql",
      "0012_housing_answer_history.sql",
      "0013_account_access.sql",
      "0014_citygo_credit.sql",
      "0015_yookassa_orders.sql",
      "0016_npd_receipts.sql",
      "0017_credit_source_lots.sql",
      "0018_payment_refunds.sql",
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
    ],
  );
  const expectedJournal = migrations.map(({ name }) => ({
    name,
    checksum: digest(
      readFileSync(join(migrationDirectory, name), "utf8").replaceAll(
        "\r\n",
        "\n",
      ),
    ),
  }));
  const journal = () =>
    JSON.parse(
      psql(
        "select jsonb_agg(jsonb_build_object('name',name,'checksum',checksum) order by name collate \"C\")::text from citygo_migrations",
      ),
    );
  assert.deepEqual(journal(), expectedJournal);
  psql(upgrade18RewindSql());
  psql(upgrade18SeedSql);

  const preservedTables = [
    "users",
    "user_credentials",
    "agent_threads",
    "messages",
    "ai_credit_accounts",
    "ai_credit_entries",
    "credit_source_lots",
    "credit_hold_allocations",
    "payment_topup_orders",
    "account_security_state",
    "ai_budget",
    "ai_budget_daily",
  ];
  const snapshot = () =>
    psql(
      `select jsonb_build_object(${preservedTables
        .map(
          (table) =>
            `'${table}',(select jsonb_agg(to_jsonb(t)${table === "ai_budget" ? "-'mode'" : table === "payment_topup_orders" ? "-'payload_version'-'receipt_email'-'receipt_profile'" : table === "agent_threads" ? "-'conversation_agent_key'" : ""} order by to_jsonb(t)::text) from ${table} t)`,
        )
        .join(",")})::text`,
    );
  const before = snapshot();
  const schemaSnapshot = () =>
    psql(`select jsonb_build_object(
      'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text) order by c.relname)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','S','v')),
      'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl::text) order by c.relname,a.attname)
        from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and a.attnum>0 and not a.attisdropped and a.attacl is not null),
      'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) order by p.proname,p.oid)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
      'constraints',(select jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.oid)
        from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'))::text`);
  const schemaBefore = schemaSnapshot();
  const assertEighteen = () => {
    assert.deepEqual(journal(), expectedJournal.slice(0, 18));
    assert.equal(
      psql(
        "select count(*) from information_schema.columns where table_schema='public' and table_name='agent_threads' and column_name='conversation_agent_key'",
      ),
      "0",
    );
    assert.equal(
      psql(
        "select to_regclass('public.payment_notification_inbox') is null and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='ai_budget' and column_name='mode') and exists(select 1 from pg_constraint where conrelid='payment_topup_orders'::regclass and conname='payment_topup_orders_test_check')",
      ),
      "t",
    );
    assert.equal(snapshot(), before);
    assert.equal(schemaSnapshot(), schemaBefore);
  };
  assertEighteen();

  const grants = readFileSync(join(root, "deploy/postgres/grants.sql"));
  const plan = {
    version: 1,
    kind: "citygo-release-migration",
    operationId: randomUUID(),
    targetSha: "a".repeat(40),
    currentMigrations: migrations.slice(0, 18),
    targetMigrations: migrations,
    grantsSha256: digest(grants),
  };
  const run = (request, { fail = false, mounts = [] } = {}) => {
    assertOwnedFixture();
    return compose(
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
  };
  assert.equal(
    psql(
      "select not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls) from pg_roles where rolname='citygo_migrator'",
    ),
    "t",
  );
  const grantText = grants.toString("utf8");
  assert.match(grantText, /commit;\s*$/);
  const failingGrants = grantText.replace(
    /commit;\s*$/,
    "grant select on public.upgrade18_intentionally_missing to citygo_api;\ncommit;\n",
  );
  const failingFile = join(directory, "upgrade18-failing-grants.sql");
  writeFileSync(failingFile, failingGrants, { flag: "wx", mode: 0o444 });
  const failed = run(
    { ...plan, grantsSha256: digest(failingGrants) },
    { fail: true, mounts: [`${failingFile}:/app/release-grants.sql:ro`] },
  );
  assert.equal(failed.trim(), "", "Failed DDL/ACLs have no commit receipt");
  assertEighteen();
  const request = { ...plan, operationId: randomUUID() };
  const result = JSON.parse(run(request));
  assert.equal(result.kind, "citygo-release-migration-result");
  assert.equal(result.operationId, request.operationId);
  assert.equal(result.targetSha, request.targetSha);
  assert.equal(result.requestSha256, digest(JSON.stringify(request)));
  assert.equal(result.committed, true);
  assert.equal(result.trafficAuthorized, false);
  assert.deepEqual(result.applied, migrations.slice(18));
  assert.equal(result.grantsSha256, digest(grants));
  assert.deepEqual(journal(), expectedJournal);
  assert.equal(snapshot(), before, "Preserve schema-18 history and money");
  assert.equal(
    psql(
      `select conversation_agent_key is null from agent_threads where user_id=${userId}`,
    ),
    "t",
    "Historical thread remains legacy; migration must not choose a helper",
  );
  assert.equal(
    psql(
      "select payload_version=1 and receipt_email is null and receipt_profile is null from payment_topup_orders where id='" +
        orderId +
        "'",
    ),
    "t",
    "Historical order remains receipt-free v1",
  );
  assertClosedPaymentAdmission(psql);
  assertPaymentAdmissionAcls(psql);
  assert.equal(budget().mode, "fixed", "Migration cannot opt in to spending");
  assert.equal(
    psql(
      "select not exists(select 1 from pg_constraint where conrelid='payment_topup_orders'::regclass and conname='payment_topup_orders_test_check')",
    ),
    "t",
  );
  assert.equal(
    psql(
      "select has_table_privilege('citygo_api','payment_notification_inbox','SELECT') and has_table_privilege('citygo_api','payment_notification_inbox','INSERT') and has_table_privilege('citygo_backup','payment_notification_inbox','SELECT') and has_column_privilege('citygo_api','payment_notification_inbox','status','UPDATE') and not has_column_privilege('citygo_api','payment_notification_inbox','object_id','UPDATE') and not has_table_privilege('citygo_api','payment_notification_inbox','UPDATE') and not has_table_privilege('citygo_api','payment_notification_inbox','DELETE') and not has_table_privilege('citygo_api','payment_notification_inbox','TRUNCATE') and not has_table_privilege('citygo_worker','payment_notification_inbox','SELECT') and not has_table_privilege('citygo_worker','payment_notification_inbox','INSERT') and not has_table_privilege('citygo_worker','payment_notification_inbox','UPDATE') and not has_table_privilege('citygo_api','citygo_migrations','UPDATE')",
    ),
    "t",
  );

  // Remove only the fixed synthetic identities after revalidating ownership.
  // The sticky sandbox mode can reset only after all fixture users/orders are
  // gone and the budget is disabled; it is not bypassed or changed by migration.
  assertOwnedFixture();
  assert.equal(
    psql(
      `select count(*) from users where id=${userId} and auth_subject='${authSubject}'`,
    ),
    "1",
  );
  psql(upgrade18CleanupSql);
  for (const table of emptyTables)
    assert.equal(psql(`select count(*) from ${table}`), "0");
  assert.deepEqual(budget(), defaultBudget);
  assert.equal(
    psql(
      "select not test_payments_seen and not real_ai_admitted and not bootstrap_completed from account_security_state where id=1",
    ),
    "t",
  );
  assert.deepEqual(journal(), expectedJournal);
  console.log(
    "Exact synthetic 18→33 rehearsal passed: fifteen migrations + ACLs, late-ACL transactional rollback, preserved legacy conversation/fixed budget/counters/test order/source hold and receipt-free v1 identity; empty pending-email/contact schema and unbound phone policy, least-privilege runtime, closed checkout, no production authorization or provider calls",
  );
}

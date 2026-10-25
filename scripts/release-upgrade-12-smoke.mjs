// Only the disposable pilot harness, before its API/Worker starts. This is not
// production rollback tooling: the harness already owns an empty current DB.
// Rehearsing 12→30 here does not authorize any production release or alter the
// separately pinned historical 12→18 controller profile and approvals.
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
const userId = 900012;
const authSubject = "upgrade12-disposable-fixture";
const holdId = "00000000-0000-4000-8000-000000120004";

export async function releaseUpgrade12Smoke({
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

  // Resolve ownership from Docker as well as the caller's random project name.
  // No API, Worker, one-off migrator, or unexpected peer may be present while
  // this fixture rewinds its own empty DB. The working deployment is never a
  // valid target, even if someone directly imports this helper.
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
  assert.equal(psql("select count(*) from users"), "0");
  assert.equal(psql("select count(*) from ai_credit_entries"), "0");

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

  // Synthetic-only rewind: unlike the older 9→current drill, actual 0010–0012
  // structures, constraints and journal entries remain in place.
  psql(`begin;
    drop table payment_admission_commands,payment_admission_reconciliation_events,payment_admission;
    drop function citygo_guard_payment_admission_history();
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
    -- Remove 0025 only in this verified empty disposable fixture. Restore the
    -- original legacy-only schema before creating the historical thread.
    drop trigger assistant_conversation_identity on agent_threads;
    drop function citygo_guard_assistant_conversation();
    drop index one_open_thread_per_assistant;
    drop index agent_threads_owner_history;
    drop index one_open_thread_per_user;
    alter table agent_threads drop column conversation_agent_key;
    create unique index one_open_thread_per_user on agent_threads(user_id) where status<>'closed';
    -- Exact synthetic 0024 rewind; deleting only its journal would leave debt
    -- triggers/constraints in a fixture claiming to be the historical schema.
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
    alter table account_security_state drop column test_payments_seen,drop column real_ai_admitted;
    drop table ai_credit_topups;
    drop index ai_credit_entry_topup_identity;
    alter table ai_credit_charges drop column tariff_snapshot,drop column real_ceiling_micros;
    alter table ai_credit_accounts drop constraint ai_credit_accounts_granted_micros_check,
      add constraint ai_credit_accounts_granted_micros_check check(granted_micros in (0,500000000));
    alter table ai_credit_entries drop constraint ai_credit_entries_kind_check,
      drop constraint ai_credit_entries_amount_micros_check,drop constraint ai_credit_entries_check;
    alter table ai_credit_entries add constraint ai_credit_entries_kind_check check(kind in ('bonus','hold','settle','release')),
      add constraint ai_credit_entries_amount_micros_check check(amount_micros between 0 and 500000000),
      add constraint ai_credit_entries_check check(
        (kind='bonus' and amount_micros=500000000 and hold_id is null and actor_user_id is not null)
        or(kind='hold' and amount_micros>0 and hold_id is null and actor_user_id is null)
        or(kind in ('settle','release') and hold_id is not null and actor_user_id is null));
    drop table account_security_state;
    alter table users drop column username,drop column role,drop column must_change_password;
    delete from citygo_migrations where name in (
      '0013_account_access.sql','0014_citygo_credit.sql','0015_yookassa_orders.sql',
      '0016_npd_receipts.sql','0017_credit_source_lots.sql','0018_payment_refunds.sql',
      '0019_yookassa_live_orders.sql','0020_ai_budget_provider_balance.sql','0021_payment_notifications.sql','0022_payment_admission.sql','0023_payment_receipt_snapshots.sql','0024_ai_credit_overdraft.sql','0025_assistant_conversations.sql','0026_email_registration.sql','0027_phone_verification.sql','0028_password_recovery.sql','0029_personal_plan.sql','0030_service_consents.sql');
    commit`);

  psql(`begin;
    insert into users(id,auth_subject) overriding system value values(${userId},'${authSubject}');
    insert into user_credentials(user_id,email,password_hash)
      values(${userId},'upgrade12@example.test','synthetic-not-a-login-hash');
    insert into sessions(token_hash,user_id,expires_at)
      values(repeat('c',64),${userId},'2099-01-01');
    insert into relocation_profiles(user_id,origin_city,target_city,preferences)
      values(${userId},'Тверь','Москва','{"synthetic":true}');
    insert into questionnaire_answers(user_id,question_key,answer)
      values(${userId},'originCity','"Тверь"');
    insert into relocation_plans(user_id,status,plan,created_at,updated_at)
      values(${userId},'active','{"stages":["housing-brief","housing-viewing"]}','2026-01-01','2026-01-01');
    insert into user_quests(user_id,quest_id,plan_id,plan_version,state,started_at,completed_at,created_at,updated_at)
      select ${userId},q.id,p.id,p.version,case when q.slug='housing-brief' then 'completed' else 'locked' end,
        case when q.slug='housing-brief' then '2026-01-02'::timestamptz end,
        case when q.slug='housing-brief' then '2026-01-03'::timestamptz end,'2026-01-01','2026-01-03'
      from quests q cross join relocation_plans p where p.user_id=${userId};
    insert into xp_events(user_id,user_quest_id,event_key,points,created_at)
      select ${userId},uq.id,'quest-complete:'||uq.id::text,60,'2026-01-03'
      from user_quests uq where uq.user_id=${userId} and uq.state='completed';
    insert into agent_threads(user_id,agent_key,context) values(${userId},'housing','{"synthetic":true}');
    insert into messages(thread_id,role,content)
      select id,'user','Синтетическая история до обновления' from agent_threads where user_id=${userId};
    insert into r1_housing_briefs(user_id,plan_id,plan_version)
      select ${userId},id,version from relocation_plans where user_id=${userId};
    insert into r1_housing_commands(user_id,command_id,event_id,action,actor,source,request,brief_id,result_revision)
      select ${userId},'00000000-0000-4000-8000-000000120010','00000000-0000-4000-8000-000000120011',
        'create_brief','user','explicit_command','{}',id,1 from r1_housing_briefs where user_id=${userId};
    insert into r1_housing_brief_revisions(brief_id,revision,event_id,content)
      select id,1,'00000000-0000-4000-8000-000000120011','{"synthetic":true}'
      from r1_housing_briefs where user_id=${userId};
    insert into ai_consents(user_id,policy_id,granted) values(${userId},repeat('a',64),true);
    insert into ai_credit_accounts(user_id,granted_micros,spent_micros,held_micros)
      values(${userId},500000000,25000000,75000000);
    insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id)
      values(${userId},'00000000-0000-4000-8000-000000120001','bonus',500000000,${userId});
    insert into ai_credit_entries(user_id,operation_id,kind,amount_micros)
      values(${userId},'00000000-0000-4000-8000-000000120002','hold',100000000);
    insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id)
      values(${userId},'00000000-0000-4000-8000-000000120003','settle',25000000,'00000000-0000-4000-8000-000000120002');
    insert into ai_credit_entries(user_id,operation_id,kind,amount_micros)
      values(${userId},'${holdId}','hold',75000000);
    commit`);
  const preserved = [
    ["users", "id", "-'username'-'role'-'must_change_password'"],
    ["user_credentials", "user_id"],
    ["sessions", "user_id"],
    ["relocation_profiles", "user_id"],
    ["questionnaire_answers", "user_id"],
    ["relocation_plans", "user_id"],
    ["user_quests", "user_id"],
    ["xp_events", "user_id"],
    ["agent_threads", "user_id", "-'conversation_agent_key'"],
    ["messages", "thread_id", "", "select id from agent_threads"],
    ["r1_housing_briefs", "user_id"],
    ["r1_housing_commands", "user_id"],
    [
      "r1_housing_brief_revisions",
      "brief_id",
      "",
      "select id from r1_housing_briefs",
    ],
    ["ai_consents", "user_id"],
    ["ai_credit_accounts", "user_id", "-'billing_review_required'"],
    ["ai_credit_entries", "user_id"],
  ];
  const snapshot = () =>
    psql(
      `select jsonb_build_object(${preserved
        .map(
          ([table, field, excluded = "", ownerQuery]) =>
            `'${table}',(select jsonb_agg(to_jsonb(t)${excluded} order by to_jsonb(t)::text)
              from ${table} t where ${field} ${ownerQuery ? `in (${ownerQuery} where user_id=${userId})` : `=${userId}`})`,
        )
        .join(",")})::text`,
    );
  const before = snapshot();
  const aclSnapshot = () =>
    psql(`select jsonb_build_object(
      'tables',(select jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text) order by c.relname)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','S','v')),
      'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl::text) order by c.relname,a.attname)
        from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and a.attnum>0 and not a.attisdropped and a.attacl is not null))::text`);
  const aclBefore = aclSnapshot();
  const assertTwelve = () => {
    assert.deepEqual(journal(), expectedJournal.slice(0, 12));
    assert.equal(
      psql(
        "select count(*) from information_schema.columns where table_schema='public' and table_name='agent_threads' and column_name='conversation_agent_key'",
      ),
      "0",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.tables where table_schema='public' and table_name in ('account_security_state','ai_credit_topups','payment_topup_orders','npd_receipt_tasks','npd_receipt_commands','npd_receipt_evidence','npd_refund_observations','credit_source_lots','credit_hold_allocations','credit_refund_allocations','payment_refunds','payment_refund_events','payment_notification_inbox')",
      ),
      "0",
    );
    assert.equal(
      psql(
        "select count(*) from information_schema.columns where table_schema='public' and table_name='users' and column_name in ('username','role','must_change_password')",
      ),
      "0",
    );
    assert.equal(snapshot(), before);
    assert.equal(
      aclSnapshot(),
      aclBefore,
      "Failed ACLs roll back with the DDL",
    );
    assert.equal(
      psql(
        "select count(*) from citygo_quest_plan_preflight where issue is not null",
      ),
      "0",
    );
  };
  assertTwelve();
  const grants = readFileSync(join(root, "deploy/postgres/grants.sql"));
  const plan = {
    version: 1,
    kind: "citygo-release-migration",
    operationId: randomUUID(),
    targetSha: "a".repeat(40),
    currentMigrations: migrations.slice(0, 12),
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
  // A valid hash and valid SQL grammar, but a deliberately failing LAST ACL.
  // This reaches actual DDL + earlier grants, then proves their shared rollback.
  const grantText = grants.toString("utf8");
  assert.match(grantText, /commit;\s*$/);
  const failingGrants = grantText.replace(
    /commit;\s*$/,
    "grant select on public.upgrade12_intentionally_missing to citygo_api;\ncommit;\n",
  );
  const failingFile = join(directory, "upgrade12-failing-grants.sql");
  writeFileSync(failingFile, failingGrants, { flag: "wx", mode: 0o444 });
  const failed = run(
    { ...plan, grantsSha256: digest(failingGrants) },
    { fail: true, mounts: [`${failingFile}:/app/release-grants.sql:ro`] },
  );
  assert.equal(
    failed.trim(),
    "",
    "Rolled-back DDL must have no success receipt",
  );
  assertTwelve();
  const request = { ...plan, operationId: randomUUID() };
  const result = JSON.parse(run(request));
  assert.equal(result.kind, "citygo-release-migration-result");
  assert.equal(result.operationId, request.operationId);
  assert.equal(result.targetSha, request.targetSha);
  assert.equal(result.requestSha256, digest(JSON.stringify(request)));
  assert.equal(result.committed, true);
  assert.equal(result.trafficAuthorized, false);
  assert.deepEqual(result.applied, migrations.slice(12));
  assert.equal(result.grantsSha256, digest(grants));
  assert.deepEqual(journal(), expectedJournal);
  assert.equal(
    snapshot(),
    before,
    "Preserve actual 12-era data, IDs and history",
  );
  assert.equal(
    psql(
      `select conversation_agent_key is null from agent_threads where user_id=${userId}`,
    ),
    "t",
    "Historical thread remains legacy; migration must not choose a helper",
  );
  assert.equal(
    psql(
      `select kind||':'||gross_micros::text||':'||spent_micros::text||':'||held_micros::text
       from credit_source_lots where user_id=${userId}`,
    ),
    "legacy_nonrefundable:500000000:25000000:75000000",
  );
  assert.equal(
    psql(
      `select a.hold_id::text||':'||a.reserved_micros::text||':'||a.state
       from credit_hold_allocations a join credit_source_lots l on l.id=a.source_lot_id
       where l.user_id=${userId}`,
    ),
    `${holdId}:75000000:reserved`,
  );
  assert.equal(
    psql(
      `select not billing_review_required from ai_credit_accounts where user_id=${userId}`,
    ),
    "t",
  );
  const moneyTables = [
    "payment_notification_inbox",
    "credit_source_lots",
    "credit_hold_allocations",
    "credit_refund_allocations",
    "payment_refunds",
    "payment_refund_events",
    "npd_receipt_tasks",
    "npd_receipt_commands",
    "npd_receipt_evidence",
    "npd_refund_observations",
  ];
  for (const table of moneyTables) {
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','SELECT') and has_table_privilege('citygo_api','${table}','INSERT') and has_table_privilege('citygo_backup','${table}','SELECT')`,
      ),
      "t",
    );
    assert.equal(
      psql(
        `select has_table_privilege('citygo_api','${table}','UPDATE') or has_table_privilege('citygo_api','${table}','DELETE') or has_table_privilege('citygo_api','${table}','TRUNCATE') or has_table_privilege('citygo_worker','${table}','SELECT') or has_table_privilege('citygo_worker','${table}','INSERT')`,
      ),
      "f",
    );
  }
  assert.equal(
    psql(
      "select has_column_privilege('citygo_api','credit_source_lots','held_micros','UPDATE') and not has_column_privilege('citygo_api','credit_source_lots','gross_micros','UPDATE') and has_column_privilege('citygo_api','payment_refunds','status','UPDATE') and not has_column_privilege('citygo_api','payment_refunds','amount_kopeks','UPDATE') and has_column_privilege('citygo_api','npd_receipt_tasks','revision','UPDATE') and not has_column_privilege('citygo_api','npd_receipt_tasks','buyer_email','UPDATE') and has_column_privilege('citygo_api','payment_notification_inbox','status','UPDATE') and not has_column_privilege('citygo_api','payment_notification_inbox','object_id','UPDATE') and not has_table_privilege('citygo_api','citygo_migrations','UPDATE')",
    ),
    "t",
  );
  for (const table of [
    "r1_housing_briefs",
    "r1_housing_commands",
    "r1_housing_brief_revisions",
  ]) {
    assert.equal(
      psql(
        `select has_table_privilege('citygo_backup','${table}','SELECT') and not has_table_privilege('citygo_api','${table}','SELECT') and not has_table_privilege('citygo_worker','${table}','SELECT')`,
      ),
      "t",
    );
  }
  assert.equal(
    psql(
      `select username is null and role='user' and not must_change_password from users where id=${userId}`,
    ),
    "t",
  );
  assert.equal(
    psql(
      "select not bootstrap_completed and not test_payments_seen and not real_ai_admitted from account_security_state where id=1",
    ),
    "t",
  );
  // Restore the empty fixture baseline for subsequent API/profile checks.
  // No real AI attempts, payments, fiscal tasks or refundable sources were made.
  assertOwnedFixture();
  assert.equal(
    psql(
      `select count(*) from users where id=${userId} and auth_subject='${authSubject}'`,
    ),
    "1",
  );
  psql(`begin;
    delete from credit_hold_allocations where source_lot_id in(select id from credit_source_lots where user_id=${userId});
    delete from credit_source_lots where user_id=${userId};
    delete from ai_credit_entries where user_id=${userId};
    delete from ai_credit_accounts where user_id=${userId};
    delete from users where id=${userId} and auth_subject='${authSubject}';
    commit`);
  assert.equal(psql("select count(*) from users"), "0");
  assert.equal(psql("select count(*) from ai_credit_entries"), "0");
  assert.equal(psql("select count(*) from ai_model_attempts"), "0");
  assert.deepEqual(journal(), expectedJournal);
  assertClosedPaymentAdmission(psql);
  assertPaymentAdmissionAcls(psql);
  console.log(
    "Exact synthetic 12→30 rehearsal passed: eighteen current migrations + ACLs, late-grants transactional rollback, preserved 12-era data and legacy conversation, conservative source backfill, empty pending-email schema and unbound phone policy, restricted runtime roles; closed checkout, no production authorization, deploy or provider calls",
  );
}

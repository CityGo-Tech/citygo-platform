import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { root } from "./env.mjs";
import { releaseUpgrade12Smoke } from "./release-upgrade-12-smoke.mjs";

// Use the DB package's existing declared dependency, not a second toolchain or
// a network PostgreSQL connection. The regression executes the literal fixture
// SQL; the full container rehearsal separately verifies restricted-role DDL.
const dbRequire = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { PGlite } = await import(
  pathToFileURL(dbRequire.resolve("@electric-sql/pglite")).href
);
const source = readFileSync(
  join(root, "scripts/release-upgrade-12-smoke.mjs"),
  "utf8",
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

test("the upgrade rehearsal rejects a production project before Docker or database I/O", async () => {
  const unexpected = () =>
    assert.fail("No fixture I/O before ownership guards");
  await assert.rejects(
    releaseUpgrade12Smoke({
      project: "citygo-production",
      directory: "not-a-disposable-fixture",
      compose: unexpected,
      docker: unexpected,
      psql: unexpected,
    }),
    /citygo-pilot-test/,
  );
});

test("literal 12-era fixture rewinds current 35, rolls back late ACL failure and reapplies without losing data", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  assert.equal(migrations.length, 35);
  assert.equal(migrations[11].name, "0012_housing_answer_history.sql");
  assert.equal(migrations.at(-1).name, "0035_ai_request_consent_bases.sql");
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
          "grant select on public.upgrade12_intentionally_missing to citygo_api",
        );
    });
  await apply(migrations);

  const rewind =
    /psql\(\s*`(begin;\s*drop table payment_admission_commands,payment_admission_reconciliation_events,payment_admission;[\s\S]*?commit)`/.exec(
      source,
    );
  assert.ok(
    rewind,
    "Execute the helper's exact static rewind, not a second copy",
  );
  assert.equal(rewind[1].includes("${"), false);
  const confirmationUser = (
    await db.query(
      "insert into users(auth_subject) values('upgrade12-confirmation-canary') returning id",
    )
  ).rows[0].id;
  await db.query(
    `insert into account_email_confirmation_challenges
     (id,user_id,email,credential_digest,session_token_hash,proof_hash,code_hash,recipient_key,expires_at)
     values('00000000-0000-4000-8000-000000120031',$1,'upgrade12@example.test',$2,$2,$2,$2,$2,clock_timestamp()+interval '10 minutes')`,
    [confirmationUser, "cd".repeat(32)],
  );
  await assert.rejects(
    db.exec(rewind[1]),
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
    [{ confirmation: 1, migrations: 35, admission: true, guard: true }],
  );
  // Only this in-memory fixture's canary is removed; populated real history
  // remains a hard stop for every disposable rewind and reset helper.
  await db.query("delete from account_email_confirmation_challenges");
  await db.query("delete from users where id=$1", [confirmationUser]);
  const recoveryId = "00000000-0000-4000-8000-000000120028";
  await db.query(
    "insert into password_recovery_challenges(id,proof_hash,code_hash,recipient_key,expires_at) values($1,$2,$2,$2,clock_timestamp()+interval '10 minutes')",
    [recoveryId, "ab".repeat(32)],
  );
  await assert.rejects(
    db.exec(rewind[1]),
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
    [{ recovery: 1, migrations: 35, admission: true, guard: true }],
    "Rejected rewind retains recovery history and rolls back earlier DDL",
  );
  // Remove only this synthetic in-memory test row before the existing empty
  // fixture rehearsal; runtime and release helpers never erase recovery history.
  await db.query("delete from password_recovery_challenges where id=$1", [
    recoveryId,
  ]);
  await db.exec(rewind[1]);
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
    "The historical fixture has no 0024 structures or relaxed account constraint",
  );
  const journal = async () =>
    (
      await db.query(
        'select name,checksum from citygo_migrations order by name collate "C"',
      )
    ).rows;
  assert.deepEqual(
    await journal(),
    migrations.slice(0, 12).map(({ name, checksum }) => ({ name, checksum })),
  );
  assert.equal(
    (
      await db.query(
        "select to_regclass('payment_notification_inbox')::text as relation",
      )
    ).rows[0].relation,
    null,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from information_schema.columns where table_schema='public' and table_name='ai_budget' and column_name='mode'",
      )
    ).rows[0].count,
    0,
  );

  // Seed the very same 12-era money/history fixture used by the real harness.
  // Only these three fixed synthetic identifiers may be interpolated.
  const seedMatch =
    /psql\(`(begin;\s*insert into users\(id,auth_subject\)[\s\S]*?commit)`/.exec(
      source,
    );
  assert.ok(seedMatch);
  const seed = seedMatch[1]
    .replaceAll("${userId}", "900012")
    .replaceAll("${authSubject}", "upgrade12-disposable-fixture")
    .replaceAll("${holdId}", "00000000-0000-4000-8000-000000120004");
  assert.equal(seed.includes("${"), false);
  await db.exec(seed);
  const history = async () =>
    (
      await db.query(`select jsonb_build_object(
    'users',(select jsonb_agg(to_jsonb(t)-'username'-'role'-'must_change_password') from users t),
    'threads',(select jsonb_agg(to_jsonb(t)-'conversation_agent_key' order by id) from agent_threads t),
    'messages',(select jsonb_agg(to_jsonb(t) order by id) from messages t),
    'credits',(select jsonb_agg(to_jsonb(t)-'billing_review_required') from ai_credit_accounts t),
    'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t)) as snapshot`)
    ).rows[0].snapshot;
  const schema = async () =>
    (
      await db.query(`select jsonb_build_object(
    'columns',(select jsonb_agg(to_jsonb(t) order by table_name,ordinal_position)
      from information_schema.columns t where table_schema='public'),
    'constraints',(select jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.oid)
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public'),
    'acls',(select jsonb_agg(jsonb_build_object('name',c.relname,'acl',c.relacl::text) order by c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public')) as snapshot`)
    ).rows[0].snapshot;
  const historyBefore = await history();
  const schemaBefore = await schema();
  const sourceJournal = await journal();
  await assert.rejects(
    apply(migrations.slice(12), true),
    /upgrade12_intentionally_missing/,
  );
  assert.deepEqual(await journal(), sourceJournal);
  assert.deepEqual(
    await schema(),
    schemaBefore,
    "The last failing ACL rolls back new DDL, columns, constraints and earlier grants",
  );
  assert.deepEqual(await history(), historyBefore);
  await apply(migrations.slice(12));
  assert.deepEqual(
    (
      await db.query(
        "select conversation_agent_key from agent_threads where user_id=900012",
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
    (
      await db.query(
        "select kind,gross_micros::text,spent_micros::text,held_micros::text from credit_source_lots where user_id=900012",
      )
    ).rows,
    [
      {
        kind: "legacy_nonrefundable",
        gross_micros: "500000000",
        spent_micros: "25000000",
        held_micros: "75000000",
      },
    ],
  );
  assert.deepEqual(
    (
      await db.query(
        "select hold_id::text,reserved_micros::text,state from credit_hold_allocations",
      )
    ).rows,
    [
      {
        hold_id: "00000000-0000-4000-8000-000000120004",
        reserved_micros: "75000000",
        state: "reserved",
      },
    ],
  );
  assert.deepEqual(
    (
      await db.query(
        "select mode,enabled,total_reserved_micros::text from ai_budget where id=1",
      )
    ).rows,
    [{ mode: "fixed", enabled: false, total_reserved_micros: "0" }],
  );
  assert.deepEqual(
    (
      await db.query(`select has_table_privilege('citygo_api','payment_notification_inbox','SELECT') as can_read,
    has_column_privilege('citygo_api','payment_notification_inbox','status','UPDATE') as can_observe,
    has_column_privilege('citygo_api','payment_notification_inbox','object_id','UPDATE') as can_rewrite,
    has_table_privilege('citygo_api','payment_notification_inbox','DELETE') as can_delete,
    has_table_privilege('citygo_worker','payment_notification_inbox','SELECT') as worker_read`)
    ).rows,
    [
      {
        can_read: true,
        can_observe: true,
        can_rewrite: false,
        can_delete: false,
        worker_read: false,
      },
    ],
  );
});

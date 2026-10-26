import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  Repository,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
import type { QuestPlanReference } from "@citygo/contracts";

const directory = new URL("../migrations/", import.meta.url);
async function applyThrough(db: Database, end: string) {
  await db.exec(
    "create table if not exists citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n <= end)
    .sort()) {
    if (
      (await db.query("select 1 from citygo_migrations where name=$1", [name]))
        .rows.length
    )
      continue;
    const source = await readFile(new URL(name, directory), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(
        source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
      );
      await tx.query(
        "insert into citygo_migrations(name,checksum) values ($1,$2)",
        [
          name,
          createHash("sha256")
            .update(source.replaceAll("\r\n", "\n"))
            .digest("hex"),
        ],
      );
    });
  }
}
async function fixture(t: TestContext, legacy = false) {
  const base = process.env.TEST_DATABASE_URL;
  let db: Database | undefined;
  if (base) {
    const url = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    // Opt-in disposable PostgreSQL only. Each case owns a fresh database so the
    // unmodified public-schema grants and migration rollback tests stay realistic.
    const name = "cg009_test_" + randomUUID().replaceAll("-", "");
    const admin = await connectDatabase(base);
    let created = false;
    t.after(async () => {
      try {
        await db?.close();
        if (created) await admin.query('drop database "' + name + '"');
      } finally {
        await admin.close();
      }
    });
    await admin.query('create database "' + name + '" template template0');
    created = true;
    url.pathname = "/" + name;
    db = await connectDatabase(url.toString());
    t.diagnostic("Backend: isolated PostgreSQL database");
  } else {
    db = await connectDatabase("pglite://:memory:");
    t.after(() => db!.close());
  }
  if (legacy) await applyThrough(db, "0009_zz.sql");
  else await migrate(db);
  return db;
}
async function user(db: Database) {
  return (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values ($1) returning id::text",
      [randomUUID()],
    )
  ).rows[0]!.id;
}
async function plan(
  db: Database,
  userId: string,
  version = 1,
  status = "active",
) {
  return (
    await db.query<QuestPlanReference>(
      "insert into relocation_plans(user_id,version,status,plan,created_at,updated_at) values ($1,$2,$3,$4,'2026-01-01','2026-01-02') returning id::text,version",
      [
        userId,
        version,
        status,
        JSON.stringify({ stages: ["housing-brief", "housing-viewing"] }),
      ],
    )
  ).rows[0]!;
}
async function quests(
  db: Database,
  userId: string,
  ref?: QuestPlanReference,
  completed = false,
) {
  return (
    await db.query<{ id: string; slug: string }>(
      `insert into user_quests(user_id,quest_id,state,started_at,completed_at,created_at,updated_at${ref ? ",plan_id,plan_version" : ""})
     select $1,id,${completed ? "'completed'" : "case when slug='housing-brief' then 'available' else 'locked' end"},
       '2026-01-03',${completed ? "'2026-01-04'" : "null"},'2026-01-02','2026-01-04'${ref ? ",$2,$3" : ""}
     from quests order by id returning id::text,(select slug from quests where id=quest_id) as slug`,
      ref ? [userId, ref.id, ref.version] : [userId],
    )
  ).rows;
}
const businessTables = [
  "users",
  "relocation_plans",
  "xp_events",
  "consent_events",
  "ai_consents",
  "ai_credit_accounts",
  "ai_credit_entries",
  "ai_budget",
  "ai_budget_daily",
  "ai_user_model_attempt_daily",
  "ai_model_attempts",
  "ai_credit_charges",
  "generated_artifacts",
];
type BusinessSnapshot = Record<string, { row: Record<string, unknown> }[]>;
async function snapshot(db: Database): Promise<BusinessSnapshot> {
  const data: BusinessSnapshot = {};
  // Preserve the complete pre-0013 user projection across upgrade. New access
  // fields are checked separately below, not ignored as migration side effects.
  for (const table of businessTables)
    data[table] = (
      await db.query<{ row: Record<string, unknown> }>(
        `select ${table === "users" ? "to_jsonb(t)-'username'-'role'-'must_change_password'" : table === "ai_credit_accounts" ? "to_jsonb(t)-'billing_review_required'" : "to_jsonb(t)"} as row from ${table} t order by to_jsonb(t)::text`,
      )
    ).rows;
  data.quests = (
    await db.query<{ row: Record<string, unknown> }>(
      "select to_jsonb(t)-'plan_id'-'plan_version' as row from user_quests t order by id",
    )
  ).rows;
  return data;
}
function withExplicitFixedBudgetMode(
  before: BusinessSnapshot,
): BusinessSnapshot {
  // This projection is used ONLY across the old-schema -> 0020 boundary.
  // Compare every old financial field unchanged and assert the one additive
  // migration default explicitly, rather than stripping it from all snapshots.
  return {
    ...before,
    ai_budget: before.ai_budget!.map(({ row }) => {
      assert.equal(Object.hasOwn(row, "mode"), false);
      return { row: { ...row, mode: "fixed" } };
    }),
  };
}
async function assertLegacyAccountDefaults(db: Database, userId: string) {
  assert.deepEqual(
    (
      await db.query(
        "select billing_review_required from ai_credit_accounts where user_id=$1",
        [userId],
      )
    ).rows,
    [{ billing_review_required: false }],
  );
  assert.deepEqual(
    (
      await db.query(
        "select username,role,must_change_password from users where id=$1",
        [userId],
      )
    ).rows,
    [{ username: null, role: "user", must_change_password: false }],
  );
  assert.deepEqual(
    (
      await db.query(
        "select id,bootstrap_completed from account_security_state",
      )
    ).rows,
    [{ id: 1, bootstrap_completed: false }],
  );
  assert.deepEqual(
    (await db.query("select mode from ai_budget where id=1")).rows,
    [{ mode: "fixed" }],
  );
}
async function financialFixture(db: Database, userId: string) {
  await db.query(
    "insert into ai_consents(user_id,policy_id,granted) values ($1,$2,true)",
    [userId, "a".repeat(64)],
  );
  await db.query(
    "insert into consent_events(user_id,consent_key,action,policy_version) values ($1,'ai-recipient','granted','synthetic')",
    [userId],
  );
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros,held_micros,spent_micros) values ($1,500000000,0,0)",
    [userId],
  );
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id) values ($1,$2,'bonus',500000000,$1)",
    [userId, randomUUID()],
  );
}

for (const status of ["active", "completed"]) {
  test(`legacy ${status} backfill preserves all old fields, XP and consent/credit; replay is zero`, async (t) => {
    const db = await fixture(t, true);
    const owner = await user(db);
    const ref = await plan(db, owner, 1, status);
    const rows = await quests(db, owner, undefined, true);
    await financialFixture(db, owner);
    for (const row of rows)
      await db.query(
        "insert into xp_events(user_id,user_quest_id,event_key,points,created_at) values ($1,$2,$3,60,'2026-01-04')",
        [owner, row.id, `quest-complete:${row.id}`],
      );
    const before = await snapshot(db);
    // First isolate CG-009's original 0009 -> 0011 backfill: it must preserve
    // every old financial/progress field before unrelated newer DDL is applied.
    await applyThrough(db, "0011_quest_plan_validate.sql");
    assert.deepEqual(await snapshot(db), before);
    await migrate(db);
    const expected = withExplicitFixedBudgetMode(before);
    assert.deepEqual(await snapshot(db), expected);
    await migrate(db);
    assert.deepEqual(await snapshot(db), expected);
    await assertLegacyAccountDefaults(db, owner);
    assert.deepEqual(
      (
        await db.query(
          "select distinct plan_id::text as id,plan_version as version from user_quests",
        )
      ).rows,
      [ref],
    );
    const repo = new Repository(db);
    for (const row of rows)
      assert.deepEqual(await repo.complete(owner, row.id), { awarded: 0 });
    const board = await repo.dashboard(
      { id: owner, email: "legacy@example.test" },
      "unconfigured",
      null,
      20,
    );
    assert.equal(board.xp, 120);
    assert.equal(board.quests.length, 2);
    assert.deepEqual(board.quests[0]!.plan, ref);
    assert.deepEqual(await snapshot(db), expected);
  });
}

const blockedCases: {
  reason: string;
  mutate: (
    db: Database,
    owner: string,
    ref: QuestPlanReference,
  ) => Promise<unknown>;
}[] = [
  {
    reason: "missing_plan",
    mutate: (db) => db.query("delete from relocation_plans"),
  },
  {
    reason: "ambiguous_plan",
    mutate: (db, owner) => plan(db, owner, 2, "archived"),
  },
  {
    reason: "unsupported_legacy_status",
    mutate: (db) => db.query("update relocation_plans set status='draft'"),
  },
  {
    reason: "unsupported_legacy_status",
    mutate: (db) => db.query("update relocation_plans set status='archived'"),
  },
  {
    reason: "quest_not_in_plan",
    mutate: (db) => db.query("update relocation_plans set plan='{}'"),
  },
  {
    reason: "quest_not_in_plan",
    mutate: (db) =>
      db.query(
        'update relocation_plans set plan=\'{"stages":["other-quest"]}\'',
      ),
  },
  {
    reason: "completed_plan_has_open_quest",
    mutate: (db) => db.query("update relocation_plans set status='completed'"),
  },
  {
    reason: "plan_created_after_quest",
    mutate: (db) =>
      db.query("update relocation_plans set created_at='2026-02-01'"),
  },
  {
    reason: "xp_owner_mismatch",
    mutate: async (db) => {
      const other = await user(db);
      await db.query(
        "insert into xp_events(user_id,user_quest_id,event_key,points) select $1,id,'bad-owner',60 from user_quests order by id limit 1",
        [other],
      );
    },
  },
  {
    reason: "missing_quest",
    mutate: async (db) => {
      await db.query(
        "alter table user_quests drop constraint user_quests_quest_id_fkey",
      );
      await db.query(
        "update user_quests set quest_id=99999 where quest_id=(select min(id) from quests)",
      );
    },
  },
  {
    reason: "xp_state_mismatch",
    mutate: (db, owner) =>
      db.query(
        "insert into xp_events(user_id,user_quest_id,event_key,points) select $1,id,'quest-complete:'||id::text,60 from user_quests order by id limit 1",
        [owner],
      ),
  },
  {
    reason: "missing_user",
    mutate: async (db) => {
      await db.query(
        "alter table user_quests drop constraint user_quests_user_id_fkey",
      );
      await db.query("update user_quests set user_id=99999");
    },
  },
];
for (const [index, scenario] of blockedCases.entries()) {
  test(`preflight ${index}: ${scenario.reason} blocks migration without any backfill`, async (t) => {
    const db = await fixture(t, true);
    const owner = await user(db);
    const ref = await plan(db, owner);
    await quests(db, owner);
    await scenario.mutate(db, owner, ref);
    const before = await snapshot(db);
    await applyThrough(db, "0010_zz.sql");
    assert.ok(
      (
        await db.query<{ issue: string }>(
          "select issue from citygo_quest_plan_preflight",
        )
      ).rows.some((r) => r.issue === scenario.reason),
    );
    await assert.rejects(migrate(db), /CG009_BACKFILL_BLOCKED/);
    assert.deepEqual(await snapshot(db), before);
    assert.equal(
      (await db.query("select 1 from user_quests where plan_id is not null"))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select 1 from citygo_migrations where name like '0011_%'",
        )
      ).rows.length,
      0,
    );
  });
}

test("expand accepts legacy writes; validation removes NULL escape and enforces immutable composite ownership", async (t) => {
  const db = await fixture(t, true);
  await applyThrough(db, "0010_zz.sql");
  const owner = await user(db),
    other = await user(db);
  const ref = await plan(db, owner),
    foreign = await plan(db, other);
  const rows = await quests(db, owner); // unchanged old writer after expand
  await migrate(db);
  await assert.rejects(
    db.query("insert into user_quests(user_id,quest_id) values ($1,1)", [
      other,
    ]),
    /null value/,
  );
  const unused = (
    await db.query<{ id: string }>(
      "insert into quests(slug,title,stage,xp_reward) values ('foreign-key-fixture','Synthetic','housing',60) returning id::text",
    )
  ).rows[0]!.id;
  for (const binding of [
    [owner, foreign.id, foreign.version],
    [other, ref.id, ref.version],
    [other, foreign.id, 99],
  ])
    await assert.rejects(
      db.query(
        "insert into user_quests(user_id,quest_id,plan_id,plan_version) values ($1,$4,$2,$3)",
        [...binding, unused],
      ),
      /foreign key/,
    );
  await assert.rejects(
    db.query("update user_quests set plan_id=$2,user_id=$3 where id=$1", [
      rows[0]!.id,
      foreign.id,
      other,
    ]),
    /CG009_IMMUTABLE/,
  );
  await assert.rejects(
    db.query("update relocation_plans set version=3 where id=$1", [ref.id]),
    /foreign key/,
  );
  await assert.rejects(
    db.query("delete from relocation_plans where id=$1", [ref.id]),
    /foreign key/,
  );
  await assert.rejects(plan(db, owner, 2), /unique/);
});

test("unexpanded migration failure rolls all phases back and leaves old writer usable", async (t) => {
  const db = await fixture(t, true),
    owner = await user(db);
  await quests(db, owner);
  await assert.rejects(migrate(db), /CG009_BACKFILL_BLOCKED/);
  assert.equal(
    (
      await db.query(
        "select 1 from information_schema.columns where table_name='user_quests' and column_name='plan_id'",
      )
    ).rows.length,
    0,
  );
  await plan(db, owner);
  await migrate(db); // operator repaired the fixture, not a guess in migration
});

test("ambiguous empty active plans block validation even without any user quests", async (t) => {
  const db = await fixture(t, true),
    owner = await user(db);
  await plan(db, owner);
  await plan(db, owner, 2);
  await assert.rejects(migrate(db), /multiple active plans/);
});

async function advice(db: Database, threadId: string) {
  await db.query(
    "insert into messages(thread_id,role,content,metadata,created_at) values ($1,'assistant','Synthetic Housing advice', $2,clock_timestamp())",
    [
      threadId,
      JSON.stringify({
        agentKey: "housing",
        status: "complete",
        source: "model",
      }),
    ],
  );
}
const expectDomain = (code: string, statusCode: number) => (error: unknown) =>
  error instanceof DomainError &&
  error.code === code &&
  error.statusCode === statusCode;

test("two versions: current-only reads, stale/foreign commands, scoped unlock/completion and exactly-once XP", async (t) => {
  const db = await fixture(t),
    owner = await user(db),
    other = await user(db);
  const old = await plan(db, owner, 1, "archived"),
    current = await plan(db, owner, 2);
  const oldQuests = await quests(db, owner, old),
    currentQuests = await quests(db, owner, current);
  const foreign = await plan(db, other),
    repo = new Repository(db);
  await financialFixture(db, owner);
  const before = await snapshot(db);
  for (const action of [repo.start.bind(repo), repo.complete.bind(repo)]) {
    await assert.rejects(
      action(owner, oldQuests[0]!.id),
      expectDomain("PLAN_STALE", 409),
    );
    await assert.rejects(
      action(other, currentQuests[0]!.id),
      expectDomain("NOT_FOUND", 404),
    );
    await assert.rejects(
      action(owner, currentQuests[0]!.id, foreign),
      expectDomain("NOT_FOUND", 404),
    );
    await assert.rejects(
      action(owner, currentQuests[0]!.id, { ...current, version: 1 }),
      expectDomain("PLAN_STALE", 409),
    );
  }
  assert.deepEqual(await snapshot(db), before);
  const board = () =>
    repo.dashboard(
      { id: owner, email: "test@example.test" },
      "unconfigured",
      null,
      20,
    );
  assert.deepEqual(
    (await board()).quests.map((q) => q.id),
    currentQuests.map((q) => q.id),
  );
  for (const row of currentQuests) {
    const thread = await repo.start(owner, row.id, current);
    await advice(db, thread.id);
    // PGlite serializes transactions; this verifies replay, not multi-session PG locking.
    assert.deepEqual(
      (
        await Promise.all([
          repo.complete(owner, row.id),
          repo.complete(owner, row.id, current),
        ])
      )
        .map((r) => r.awarded)
        .sort((a, b) => a - b),
      [0, 60],
    );
  }
  assert.equal((await board()).xp, 120);
  assert.deepEqual(
    (
      await db.query(
        "select id::text,state from user_quests where plan_id=$1 order by id",
        [old.id],
      )
    ).rows,
    oldQuests.map((q, i) => ({
      id: q.id,
      state: i === 0 ? "available" : "locked",
    })),
  );
  assert.deepEqual(
    (
      await db.query(
        "select id::text,status from relocation_plans where user_id=$1 order by version",
        [owner],
      )
    ).rows,
    [
      { id: old.id, status: "archived" },
      { id: current.id, status: "completed" },
    ],
  );
  const after = await snapshot(db);
  for (const table of [
    "ai_consents",
    "consent_events",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_budget",
    "ai_budget_daily",
    "generated_artifacts",
  ])
    assert.deepEqual(after[table], before[table]);
  const replaySnapshot = await snapshot(db);
  assert.deepEqual(await repo.complete(owner, currentQuests[1]!.id), {
    awarded: 0,
  });
  assert.deepEqual(await snapshot(db), replaySnapshot);
  await assert.rejects(
    repo.start(owner, currentQuests[0]!.id),
    expectDomain("PLAN_STALE", 409),
  );
});

test("a newer completed plan supersedes an older active row for commands and reads", async (t) => {
  const db = await fixture(t),
    owner = await user(db);
  const older = await plan(db, owner, 1),
    newer = await plan(db, owner, 2, "completed");
  const oldQuests = await quests(db, owner, older),
    latest = await quests(db, owner, newer, true);
  const repo = new Repository(db);
  await assert.rejects(
    repo.start(owner, oldQuests[0]!.id),
    expectDomain("PLAN_STALE", 409),
  );
  const board = await repo.dashboard(
    { id: owner, email: "test@example.test" },
    "unconfigured",
    null,
    20,
  );
  assert.deepEqual(
    board.quests.map((q) => q.id),
    latest.map((q) => q.id),
  );
});

test("XP insertion failure rolls back completion and unlock atomically", async (t) => {
  const db = await fixture(t),
    owner = await user(db),
    ref = await plan(db, owner);
  const rows = await quests(db, owner, ref),
    repo = new Repository(db);
  const thread = await repo.start(owner, rows[0]!.id);
  await advice(db, thread.id);
  // Corrupt fixture only: emulate an existing conflicting award, never remove it.
  await db.query(
    "insert into xp_events(user_id,user_quest_id,event_key,points) values ($1,$2,$3,60)",
    [owner, rows[0]!.id, `quest-complete:${rows[0]!.id}`],
  );
  const before = await snapshot(db);
  await assert.rejects(repo.complete(owner, rows[0]!.id), /unique/);
  assert.deepEqual(await snapshot(db), before);
});

test("existing least-privilege API grants can start/complete after identity trigger is installed", async (t) => {
  const db = await fixture(t),
    owner = await user(db),
    ref = await plan(db, owner);
  const rows = await quests(db, owner, ref);
  const suffix = randomUUID().replaceAll("-", "");
  const roles = {
    citygo_api: `cg009_api_${suffix}`,
    citygo_worker: `cg009_worker_${suffix}`,
    citygo_backup: `cg009_backup_${suffix}`,
  };
  const created: string[] = [];
  const failures: unknown[] = [];
  // Driver-level role check, not a substitute for the deployed migration-role drill.
  try {
    for (const role of Object.values(roles)) {
      assert.match(role, /^cg009_(api|worker|backup)_[a-f0-9]{32}$/);
      await db.exec(`create role ${role} nologin`);
      created.push(role);
      await db.exec(`grant usage on schema public to ${role}`);
    }
    const grants = (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    )
      .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
      .replace(
        /\bcitygo_(api|worker|backup)\b/g,
        (name) => roles[name as keyof typeof roles],
      );
    await db.exec(grants);
    // Preserve real Repository transaction boundaries. Every transaction and
    // standalone query runs as the API role on its own pinned connection.
    // Never SET ROLE on the pool or emulate nested transactions with callbacks.
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        assert.equal(
          (await tx.query<{ role: string }>("select current_user as role"))
            .rows[0]!.role,
          roles.citygo_api,
        );
        return work(tx);
      });
    const apiDb: Database = {
      ...db,
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      transaction: asApi,
    };
    const repo = new Repository(apiDb);
    const thread = await repo.start(owner, rows[0]!.id);
    await advice(apiDb, thread.id);
    assert.deepEqual(await repo.complete(owner, rows[0]!.id), { awarded: 60 });
    assert.deepEqual(await repo.complete(owner, rows[0]!.id), { awarded: 0 });
    await assert.rejects(
      apiDb.query("select * from citygo_quest_plan_preflight"),
      { code: "42501" },
    );
    assert.equal(
      (
        await db.query<{ reset: boolean }>(
          "select current_user = session_user as reset",
        )
      ).rows[0]!.reset,
      true,
      "restricted role must not leak after commit or rollback",
    );
  } catch (error) {
    failures.push(error);
  } finally {
    // Roles are cluster-global. Clean only roles created here, before t.after
    // drops this fixture database; preserve both test and cleanup failures.
    for (const role of created.reverse()) {
      try {
        await db.exec(`drop owned by ${role}; drop role ${role}`);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      assert.deepEqual(
        (
          await db.query(
            "select rolname from pg_roles where rolname = any($1::text[])",
            [created],
          )
        ).rows,
        [],
        "generated CG-009 roles must not remain in the cluster",
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "CG-009 API grants test or cleanup failed",
    );
});

test("container smoke's actual synthetic rewind/seed SQL upgrades from 9 to current and preserves populated history", async (t) => {
  const db = await fixture(t);
  // Read literal fixture SQL without importing/executing the Docker harness.
  // Fail if its representation changes; never evaluate JavaScript from a file.
  const script = await readFile(
    new URL("../../../scripts/release-migration-smoke.mjs", import.meta.url),
    "utf8",
  );
  const sql = [...script.matchAll(/`(begin;[\s\S]*?commit)`/g)].map(
    (m) => m[1]!,
  );
  assert.equal(sql.length, 2);
  for (const literal of sql) assert.equal(literal.includes("${"), false);
  await db.exec(sql[0]!);
  assert.deepEqual(
    (
      await db.query(
        "select to_regclass('credit_charge_debts')::text as debts,to_regclass('credit_debt_repayments')::text as repayments,exists(select 1 from information_schema.columns where table_schema='public' and table_name='ai_credit_charges' and column_name='reservation_mode') as overdraft,exists(select 1 from pg_constraint where conrelid='ai_credit_accounts'::regclass and conname='ai_credit_accounts_check') as fully_prepaid",
      )
    ).rows,
    [{ debts: null, repayments: null, overdraft: false, fully_prepaid: true }],
    "Rewinding the disposable fixture also removes the actual overdraft schema",
  );
  assert.equal(
    (await db.query("select name from citygo_migrations")).rows.length,
    9,
  );
  await db.exec(sql[1]!);
  const before = await snapshot(db);
  await migrate(db);
  const expectedNames = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.equal(expectedNames.length, 34);
  assert.equal(expectedNames[24], "0025_assistant_conversations.sql");
  assert.equal(expectedNames.at(-1), "0034_gigachat_request_fees.sql");
  assert.deepEqual(
    (await db.query("select name from citygo_migrations order by name")).rows,
    expectedNames.map((name) => ({ name })),
  );
  assert.deepEqual(await snapshot(db), withExplicitFixedBudgetMode(before));
  await assertLegacyAccountDefaults(db, "900009");
  const cleanup = script.match(
    /"(begin; delete from credit_hold_allocations[^"\n]+commit)"/,
  )?.[1];
  assert.ok(cleanup);
  await db.exec(cleanup);
  assert.equal((await db.query("select 1 from users")).rows.length, 0);
  assert.equal(
    await user(db),
    "1",
    "later pilot registration keeps its original first ID",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, Sql } from "./index.js";
import {
  loadReleaseMigrationAssets,
  migrateRelease,
  parseReleaseMigrationPlan,
  sha256,
  transactionBody,
  type ReleaseMigrationPlan,
} from "./release-migration.js";

const first = Buffer.from("begin; create table first_table(id int); commit;\n");
const second = Buffer.from(
  "begin; alter table first_table add column added int; commit;\n",
);
const grants = Buffer.from(
  "\\set ON_ERROR_STOP on\n-- Fixed image ACLs\nbegin; grant select on first_table to citygo_api; commit;\n",
);
const assets = {
  migrations: [
    { name: "0001_first.sql", bytes: first },
    { name: "0002_second.sql", bytes: second },
  ],
  grants,
};
const plan: ReleaseMigrationPlan = {
  version: 1,
  kind: "citygo-release-migration",
  operationId: "12345678-abcd-abcd-abcd-123456789abc",
  targetSha: "a".repeat(40),
  currentMigrations: [{ name: "0001_first.sql", sha256: sha256(first) }],
  targetMigrations: assets.migrations.map(({ name, bytes }) => ({
    name,
    sha256: sha256(bytes),
  })),
  grantsSha256: sha256(grants),
};
const parse = (value: unknown) =>
  parseReleaseMigrationPlan(JSON.stringify(value));
test("bounded unambiguous release input binds exact immutable history prefix and IDs", () => {
  assert.deepEqual(
    parseReleaseMigrationPlan(JSON.stringify(plan) + "\n"),
    plan,
  );
  for (const value of [
    null,
    [],
    {},
    { ...plan, version: true },
    { ...plan, extra: "secret" },
    { ...plan, targetSha: "latest" },
    { ...plan, operationId: "invalid" },
    { ...plan, grantsSha256: "invalid" },
    { ...plan, currentMigrations: [] },
    {
      ...plan,
      targetMigrations: [plan.targetMigrations[1], plan.targetMigrations[0]],
    },
    {
      ...plan,
      targetMigrations: [plan.targetMigrations[0], plan.targetMigrations[0]],
    },
    { ...plan, currentMigrations: [plan.targetMigrations[1]] },
    {
      ...plan,
      targetMigrations: [{ name: "../first.sql", sha256: sha256(first) }],
    },
    {
      ...plan,
      currentMigrations: [
        { ...plan.currentMigrations[0], sha256: "f".repeat(64) },
      ],
    },
  ])
    assert.throws(() => parse(value), /Release migration rejected/);
  for (const text of [
    "{",
    "{}".repeat(140000),
    JSON.stringify(plan).replace('"version":1', '"version":1,"version":1'),
    JSON.stringify(plan, null, 2),
    JSON.stringify(plan).replace('"version":1', '"version":1.0'),
  ])
    assert.throws(
      () => parseReleaseMigrationPlan(text),
      /Release migration rejected/,
    );
});
test("SQL wrapper removal never executes embedded transaction boundaries or psql commands", () => {
  assert.equal(
    transactionBody(
      "-- preface\nbegin; /* nested /* ;commit; */ */ select ';commit;', E'a\\';commit;', \"semi;colon\"; do $body$ begin perform 1; end $body$; commit; -- tail",
    ).length,
    2,
  );
  for (const sql of [
    "begin; create table x(id int); commit; begin; select 1; commit;",
    "begin; select 1; /* x */ END; select 2; commit;",
    "begin; select 1; rollback; commit;",
    "begin; select 1; prepare transaction 'x'; commit;",
    "begin; set standard_conforming_strings=off; commit;",
    "begin; discard all; commit;",
    "begin; select 1; \\i other.sql\ncommit;",
    "begin; select 'unterminated; commit;",
    "begin; select $x$unterminated; commit;",
    "begin; select 1; /* unclosed",
    "begin; select 1; commit; select 2",
    "select 1;",
    "begin; commit;",
  ])
    assert.throws(() => transactionBody(sql), /Release migration rejected/);
  assert.throws(
    () => transactionBody("begin; create role nope; commit;", true),
    /sql-command/,
  );
});

function fixture({
  history = [{ name: "0001_first.sql", checksum: sha256(first) }],
  identity = {},
  fail = "",
  lock = true,
} = {}) {
  const events: string[] = [];
  let rows = structuredClone(history);
  const tx: Sql = {
    async query<T>(sql: string, params?: unknown[]) {
      events.push(sql);
      let result: unknown[] = [];
      if (sql.includes("pg_roles"))
        result = [
          {
            role: "citygo_migrator",
            session: "citygo_migrator",
            database: "citygo_pilot",
            version: 170004,
            elevated: false,
            ...identity,
          },
        ];
      else if (sql.includes("for update nowait"))
        result = lock ? [{ id: 1 }] : [];
      else if (sql.startsWith("select name")) result = structuredClone(rows);
      else if (sql.startsWith("insert into public.citygo_migrations"))
        rows.push({ name: String(params![0]), checksum: String(params![1]) });
      else throw new Error("Unexpected query");
      return { rows: result as T[] };
    },
    async exec(sql) {
      events.push(sql);
      if (fail && sql.includes(fail)) throw new Error("synthetic SQL error");
    },
  };
  const db: Database = {
    ...tx,
    async close() {},
    async transaction(work) {
      events.push("BEGIN");
      const snapshot = structuredClone(rows);
      try {
        const result = await work(tx);
        if (fail === "COMMIT") throw new Error("commit outcome unknown");
        events.push("COMMIT");
        return result;
      } catch (error) {
        rows = snapshot;
        events.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, events, history: () => rows };
}
test("one transaction locks legacy migrators, checks exact history, migrates then grants and acknowledges commit", async () => {
  const f = fixture();
  const result = await migrateRelease(f.db, plan, assets);
  assert.equal(f.events[0], "BEGIN");
  assert.equal(f.events.at(-1), "COMMIT");
  assert.equal(
    f.events.filter((s) => s.includes("for update nowait")).length,
    1,
  );
  assert.ok(
    f.events.findIndex((s) => s.startsWith("select name")) <
      f.events.findIndex((s) => s.includes("alter table first_table")),
  );
  assert.ok(
    f.events.findIndex((s) => s.includes("alter table first_table")) <
      f.events.findIndex((s) => s.includes("grant select")),
  );
  assert.equal(result.committed, true);
  assert.equal(result.trafficAuthorized, false);
  assert.deepEqual(result.applied, [plan.targetMigrations[1]]);
  assert.equal(result.requestSha256, sha256(JSON.stringify(plan)));
  assert.equal(f.history().length, 2);
  await assert.rejects(migrateRelease(f.db, plan, assets), /database-history/);
});
test("preflight rejects extra/missing/changed image files and grants before any transaction", async () => {
  for (const changed of [
    { ...assets, migrations: [] },
    { ...assets, migrations: [...assets.migrations, assets.migrations[1]!] },
    { ...assets, migrations: [assets.migrations[1]!, assets.migrations[0]!] },
    {
      ...assets,
      migrations: [
        { name: "0001_first.sql", bytes: Buffer.from("modified") },
        assets.migrations[1]!,
      ],
    },
    { ...assets, grants: Buffer.from("different") },
  ]) {
    const f = fixture();
    await assert.rejects(migrateRelease(f.db, plan, changed));
    assert.equal(f.events.length, 0);
  }
});
test("missing, unknown, non-prefix or changed database history refuses to run DDL or grants", async () => {
  for (const history of [
    [],
    [{ name: "unknown.sql", checksum: sha256(first) }],
    [{ name: "0001_first.sql", checksum: "f".repeat(64) }],
    [
      ...assets.migrations.map(({ name, bytes }) => ({
        name,
        checksum: sha256(bytes),
      })),
    ],
  ]) {
    const f = fixture({ history });
    await assert.rejects(
      migrateRelease(f.db, plan, assets),
      /database-history/,
    );
    assert.equal(f.events.at(-1), "ROLLBACK");
    assert.ok(
      !f.events.some((s) => /alter table first_table|grant select/.test(s)),
    );
  }
});
test("wrong database, role, elevated privileges, version and missing lock row are closed failures", async () => {
  for (const identity of [
    { role: "postgres" },
    { session: "postgres" },
    { database: "other" },
    { elevated: true },
    { version: 160000 },
    { version: 180000 },
  ]) {
    const f = fixture({ identity });
    await assert.rejects(
      migrateRelease(f.db, plan, assets),
      /database-identity/,
    );
    assert.equal(f.events.length, 3);
  }
  const f = fixture({ lock: false });
  await assert.rejects(migrateRelease(f.db, plan, assets), /database-lock/);
});
test("SQL/ACL failure rolls back; uncertain commit returns no success and never retries", async () => {
  for (const fail of ["alter table first_table", "grant select", "COMMIT"]) {
    const f = fixture({ fail });
    await assert.rejects(migrateRelease(f.db, plan, assets));
    assert.equal(f.history().length, 1);
    assert.equal(f.events.filter((e) => e === "BEGIN").length, 1);
    assert.equal(f.events.at(-1), "ROLLBACK");
  }
});
test("raw manifest bytes and historical LF-normalized checksums are both verified", async () => {
  const bytes = Buffer.from(first.toString().replaceAll("\n", "\r\n"));
  const crlf = {
    ...assets,
    migrations: [{ name: "0001_first.sql", bytes }, assets.migrations[1]!],
  };
  const digests = crlf.migrations.map(({ name, bytes: data }) => ({
    name,
    sha256: sha256(data),
  }));
  const f = fixture();
  await migrateRelease(
    f.db,
    { ...plan, currentMigrations: [digests[0]!], targetMigrations: digests },
    crlf,
  );
});
test("executor accepts long migration names already accepted by publisher and target gate", async () => {
  const name = `0002_${"a".repeat(150)}.sql`;
  const targetMigrations = [
    plan.targetMigrations[0]!,
    { ...plan.targetMigrations[1]!, name },
  ];
  const changed = {
    ...assets,
    migrations: [assets.migrations[0]!, { ...assets.migrations[1]!, name }],
  };
  const f = fixture();
  const result = await migrateRelease(
    f.db,
    { ...plan, targetMigrations },
    changed,
  );
  assert.equal(result.applied[0]?.name, name);
});
test("input budget accommodates both selected manifest inventories", () => {
  const migrations = Array.from({ length: 1000 }, (_, i) => ({
    name: `${String(i + 1).padStart(4, "0")}_${"a".repeat(150)}.sql`,
    sha256: "a".repeat(64),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(migrations)) < 262144);
  const input = {
    ...plan,
    currentMigrations: migrations,
    targetMigrations: migrations,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 262144);
  assert.deepEqual(parse(input), input);
  assert.throws(
    () => parseReleaseMigrationPlan(" ".repeat(524289)),
    /input-size/,
  );
});
test("asset loader matches publisher SQL and ACL size boundaries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citygo-migration-bounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrations = join(directory, "migrations");
  const sql = join(migrations, "0001_fixture.sql");
  const acl = join(directory, "grants.sql");
  await mkdir(migrations);
  await writeFile(sql, Buffer.alloc(4 * 1024 * 1024, 32));
  await writeFile(acl, Buffer.alloc(262144, 32));
  const loaded = await loadReleaseMigrationAssets(migrations, acl);
  assert.equal(loaded.migrations[0]?.bytes.length, 4 * 1024 * 1024);
  assert.equal(loaded.grants.length, 262144);
  await writeFile(sql, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  await assert.rejects(
    loadReleaseMigrationAssets(migrations, acl),
    /image-file/,
  );
  await writeFile(sql, first);
  await writeFile(acl, Buffer.alloc(262145, 32));
  await assert.rejects(
    loadReleaseMigrationAssets(migrations, acl),
    /image-file/,
  );
});
test("all shipped SQL and ACL files satisfy the guarded transaction grammar", async () => {
  const files = await loadReleaseMigrationAssets(
    fileURLToPath(new URL("../migrations", import.meta.url)),
    fileURLToPath(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    ),
  );
  for (const { bytes } of files.migrations)
    assert.ok(transactionBody(bytes.toString()).length);
  assert.ok(transactionBody(files.grants.toString(), true).length);
});

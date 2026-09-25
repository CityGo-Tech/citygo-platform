// Synthetic pilot DB only, BEFORE any API/Worker starts. Never import on a host.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { root } from "./env.mjs";

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
    7,
    "Update the disposable upgrade fixture when migrations change",
  );
  const last = migrations.at(-1);
  assert.equal(last.name, "0007_ai_user_daily_budget.sql");
  const plan = {
    version: 1,
    kind: "citygo-release-migration",
    operationId: randomUUID(),
    targetSha: "a".repeat(40),
    currentMigrations: migrations.slice(0, -1),
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
    assert.equal(psql("select count(*) from citygo_migrations"), "6");
    assert.equal(
      psql(
        "select count(*) from information_schema.columns where table_schema='public' and table_name='ai_budget' and column_name='user_daily_limit_micros'",
      ),
      "0",
    );
    assert.equal(
      psql("select has_table_privilege('citygo_api','users','SELECT')"),
      "t",
    );
  };
  // Rewind ONLY the newly created synthetic fixture, not production rollback code.
  psql(
    "begin; drop index ai_model_attempts_user_money_day_idx; alter table ai_budget drop column user_daily_limit_micros; delete from citygo_migrations where name='0007_ai_user_daily_budget.sql'; commit",
  );
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
    /^\/app\/node_modules\/[a-zA-Z0-9_@./+-]+\/migrations\/0007_ai_user_daily_budget\.sql$/,
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
    "begin; alter table ai_budget add column user_daily_limit_micros bigint; select pg_catalog.nextval('public.release_execution_probe'); select * from synthetic_missing_table; commit;\n",
    "begin; alter table ai_budget add column user_daily_limit_micros bigint; commit; begin; select * from synthetic_missing_table; commit;\n",
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
  }
  psql("drop sequence release_execution_probe");
  // A concurrent old migrator fails NOWAIT; a schema lock fails lock_timeout.
  // Hold each real PostgreSQL lock until the attempted release has failed.
  for (const query of [
    "select id from citygo_migration_lock where id=1 for update",
    "select id from ai_budget where id=1 for update",
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
  const result = run();
  assert.deepEqual(result.applied, [last]);
  assert.equal(psql("select count(*) from citygo_migrations"), "7");
  assert.equal(
    psql(
      "select count(*) from information_schema.columns where table_schema='public' and table_name='ai_budget' and column_name='user_daily_limit_micros'",
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
}

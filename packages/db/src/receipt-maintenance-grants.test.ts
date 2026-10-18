import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectDatabase, migrate } from "./index.js";
import {
  seedRestartFixture,
  seedRestartNpdObligation,
} from "./closed-account-restart-fixture.js";

const tables = [
  "npd_receipt_tasks",
  "npd_receipt_commands",
  "npd_receipt_evidence",
  "npd_refund_observations",
];

test("the disposable release fixture rewinds only reviewed new schema and reapplies all sixteen migrations", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const source = await readFile(
    new URL("../../../scripts/release-migration-smoke.mjs", import.meta.url),
    "utf8",
  );
  const rewind =
    /psql\(\s*`(begin;\s*drop trigger npd_live_topup_obligation[\s\S]*?commit)`/.exec(
      source,
    );
  assert.ok(
    rewind,
    "Test the exact static disposable rewind, not a second copy",
  );
  assert.equal(rewind[1]!.includes("${"), false);
  await db.exec(rewind[1]!);
  assert.equal(
    (await db.query("select 1 from citygo_migrations")).rows.length,
    9,
  );
  for (const table of tables)
    assert.equal(
      (
        await db.query<{ relation: string | null }>(
          "select to_regclass($1)::text as relation",
          [table],
        )
      ).rows[0]!.relation,
      null,
    );
  for (const name of [
    "citygo_guard_npd_receipt_task",
    "citygo_create_npd_receipt_task",
    "citygo_apply_npd_refund_observation",
  ])
    assert.equal(
      (await db.query("select 1 from pg_proc where proname=$1", [name])).rows
        .length,
      0,
    );
  await migrate(db);
  assert.equal(
    (await db.query("select 1 from citygo_migrations")).rows.length,
    16,
  );
});

test("reviewed NPD grants support invoker duties/session locks but not identity rewrites, history deletion or Worker access", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const data = await seedRestartFixture(db);
  await db.exec(
    "create role citygo_api; create role citygo_worker; create role citygo_backup;",
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  await db.exec(grants.replace(/^\\set[^\n]*\n/gm, ""));
  for (const table of tables) {
    const permissions = (
      await db.query<{
        can_read: boolean;
        can_append: boolean;
        broad: boolean;
      }>(
        `select has_table_privilege('citygo_api',$1,'SELECT') as can_read,
          has_table_privilege('citygo_api',$1,'INSERT') as can_append,
          (has_table_privilege('citygo_api',$1,'UPDATE') or
           has_table_privilege('citygo_api',$1,'DELETE') or
           has_table_privilege('citygo_api',$1,'TRUNCATE') or
           has_table_privilege('citygo_worker',$1,'SELECT')) as broad`,
        [table],
      )
    ).rows[0]!;
    assert.deepEqual(permissions, {
      can_read: true,
      can_append: true,
      broad: false,
    });
  }
  for (const column of [
    "buyer_email",
    "amount_kopeks",
    "user_id",
    "payment_id",
  ])
    assert.equal(
      (
        await db.query<{ writable: boolean }>(
          "select has_column_privilege('citygo_api','npd_receipt_tasks',$1,'UPDATE') as writable",
          [column],
        )
      ).rows[0]!.writable,
      false,
    );
  await db.exec("set role citygo_api");
  const obligation = await seedRestartNpdObligation(db, data.user);
  await db.transaction(async (tx) => {
    await tx.query("select token_hash from sessions for update");
    await tx.query("select id from npd_receipt_tasks where id=$1 for update", [
      obligation.operationId,
    ]);
  });
  await assert.rejects(
    db.query("update npd_receipt_tasks set buyer_email='changed@example.test'"),
    /permission denied/,
  );
  for (const table of tables) {
    await assert.rejects(db.exec(`delete from ${table}`), /permission denied/);
    await assert.rejects(
      db.exec(`truncate table ${table}`),
      /permission denied/,
    );
  }
  for (const table of tables.filter((name) => name !== "npd_receipt_tasks"))
    await assert.rejects(
      db.exec(`update ${table} set created_at=created_at`),
      /permission denied/,
    );
  await db.exec("reset role; set role citygo_worker");
  for (const table of tables)
    await assert.rejects(
      db.query(`select * from ${table}`),
      /permission denied/,
    );
  await db.exec("reset role; set role citygo_backup");
  assert.equal(
    (await db.query("select 1 from npd_receipt_tasks")).rows.length,
    1,
  );
  await db.exec("reset role");
});

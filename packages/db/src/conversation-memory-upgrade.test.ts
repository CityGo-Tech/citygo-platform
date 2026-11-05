import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { connectDatabase, migrate, ConversationMemory } from "./index.js";
import { applyFixtureMigration } from "./test-service-consents.js";
import { seedRestartFixture } from "./closed-account-restart-fixture.js";

test("schema46→47 preserves every existing row, accounting snapshot and migration checksum without inventing memory", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migration_lock(id integer primary key);insert into citygo_migration_lock values(1);create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  const old = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (name) => name.endsWith(".sql") && name < "0047_conversation_memory.sql",
    )
    .sort();
  assert.equal(old.length, 46);
  for (const name of old) await applyFixtureMigration(db, name);
  const fixture = await seedRestartFixture(db);
  const tables = (
    await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename",
    )
  ).rows.map((row) => row.tablename);
  assert.equal(tables.length, 79);
  const snapshot = async () => {
    const result: Record<string, unknown[]> = {};
    for (const table of tables) {
      assert.match(table, /^[a-z_][a-z0-9_]*$/);
      result[table] = (
        await db.query(
          `select to_jsonb(t)::text as value from ${table} t ${table === "citygo_migrations" ? "where name<'0047_conversation_memory.sql'" : ""} order by to_jsonb(t)::text`,
        )
      ).rows;
    }
    return result;
  };
  const before = await snapshot();
  await applyFixtureMigration(db, "0047_conversation_memory.sql");
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (await db.query("select * from conversation_memory_fragments")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select * from citygo_migrations")).rows.length,
    47,
  );
  assert.equal(
    (await db.query("select 1 from pg_tables where schemaname='public'")).rows
      .length,
    80,
  );
  assert.equal(
    (await db.query("select 1 from pg_sequences where schemaname='public'"))
      .rows.length,
    23,
  );
  const thread = (
    await db.query<{ id: string }>(
      "select id::text from agent_threads where user_id=$1 order by id limit 1",
      [fixture.user],
    )
  ).rows[0]!.id;
  const memory = new ConversationMemory(db);
  assert.equal(
    (await memory.snapshot(fixture.user, thread, "чат", { readOnly: true }))
      .indexComplete,
    false,
  );
  const backfilled = await memory.snapshot(fixture.user, thread, "чат");
  assert.ok(
    backfilled.fragments.some((part) => part.content === "PRIVATE-CHAT"),
  );
  assert.deepEqual(await snapshot(), before);
  await migrate(db);
  assert.equal(
    (await db.query("select * from citygo_migrations")).rows.length,
    48,
  );
  assert.deepEqual(await snapshot(), before);
});

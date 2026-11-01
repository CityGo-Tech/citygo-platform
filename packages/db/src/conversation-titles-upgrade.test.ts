import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "./index.js";
import { applyFixtureMigration } from "./test-service-consents.js";
test("schema43→44 adds no invented titles and preserves exact old thread, message and journal rows", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql") && n < "0044_conversation_titles.sql")
    .sort())
    await applyFixtureMigration(db, name);
  const owner = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject)values($1)returning id::text",
      [randomUUID()],
    )
  ).rows[0]!.id;
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,context)values($1,'support',$2::jsonb)returning id::text",
      [
        owner,
        JSON.stringify({ title: "Unrelated prompt context must remain exact" }),
      ],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content)values($1,'user','Exact old message')",
    [thread],
  );
  const journal = (
      await db.query("select * from citygo_migrations order by name")
    ).rows,
    threads = (await db.query("select * from agent_threads")).rows,
    messages = (await db.query("select * from messages")).rows;
  await migrate(db);
  assert.deepEqual(
    (
      await db.query(
        "select * from citygo_migrations where name<'0044_conversation_titles.sql'order by name",
      )
    ).rows,
    journal,
  );
  assert.deepEqual(
    (await db.query("select * from agent_threads")).rows,
    threads,
  );
  assert.deepEqual((await db.query("select * from messages")).rows, messages);
  assert.equal(
    (await db.query("select * from conversation_titles")).rows.length,
    0,
  );
});

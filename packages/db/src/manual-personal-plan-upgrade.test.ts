import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, PersonalPlan, Repository } from "./index.js";
import { applyFixtureMigration } from "./test-service-consents.js";

test("schema37 to38 retains sourced plan rows and all other data while allowing an explicit source-less step", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec("create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())");
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter(
      (name) => name.endsWith(".sql") && name < "0038_manual_personal_plan.sql",
    )
    .sort())
    await applyFixtureMigration(db, name);
  const userId = await new Repository(db).register(
    "manual-upgrade@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  const messageId = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content) values($1,'user','Synthetic preserved source') returning id::text",
      [thread],
    )
  ).rows[0]!.id;
  const store = new PersonalPlan(db);
  const created = await store.create(userId, {
    operationId: randomUUID(),
    sourceMessageId: messageId,
    title: "Исходный шаг",
    details: "Сохранить",
  });
  const rows = async () =>
    (
      await db.query(
        "select to_jsonb(p) as row from personal_plan_items p order by id",
      )
    ).rows;
  const before = await rows();
  await applyFixtureMigration(db, "0038_manual_personal_plan.sql");
  assert.deepEqual(await rows(), before);
  assert.deepEqual((await store.list(userId)).items, [created.item]);
  const manual = await store.create(userId, {
    operationId: randomUUID(),
    sourceMessageId: null,
    title: "Свой шаг",
    details: "",
  });
  assert.equal(manual.item.source, null);
  assert.equal((await store.summary(userId)).total, 2);
  await assert.rejects(
    db.query(
      "update personal_plan_items set source_message_id=null,revision=revision+1,updated_at=clock_timestamp() where id=$1",
      [created.item.id],
    ),
    { code: "23514" },
  );
  await applyFixtureMigration(db, "0038_manual_personal_plan.sql");
  assert.equal((await store.list(userId)).items.length, 2);
});

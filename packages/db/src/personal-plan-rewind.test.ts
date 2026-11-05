import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  PersonalPlan,
  Repository,
  type Database,
} from "./index.js";

async function snapshot(db: Database) {
  return (
    await db.query<{ snapshot: unknown }>(`select jsonb_build_object(
      'journal',(select jsonb_agg(to_jsonb(t) order by name) from citygo_migrations t),
      'plan',(select jsonb_agg(to_jsonb(t) order by id) from personal_plan_items t),
      'revisions',(select jsonb_agg(to_jsonb(t) order by item_id,revision) from personal_plan_item_history t),
      'users',(select jsonb_agg(to_jsonb(t) order by id) from users t),
      'threads',(select jsonb_agg(to_jsonb(t) order by id) from agent_threads t),
      'messages',(select jsonb_agg(to_jsonb(t) order by id) from messages t),
      'tables',(select jsonb_agg(table_name order by table_name)
        from information_schema.tables where table_schema='public'),
      'guards',(select jsonb_agg(jsonb_build_object('name',proname,'definition',pg_get_functiondef(oid)) order by proname)
        from pg_proc where proname in ('citygo_guard_payment_admission_history','citygo_guard_personal_plan_item'))
    ) as snapshot`)
  ).rows[0]!.snapshot;
}

test("exact disposable rewinds reject populated personal-plan history and tombstones without dropping schema or forging the migration journal", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  assert.equal(
    (await db.query("select name from citygo_migrations")).rows.length,
    49,
  );
  const owner = await new Repository(db).register(
    "plan-rewind@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key,status) values($1,'support','support','closed') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const message = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) values($1,'assistant','Synthetic next step',$2) returning id::text",
      [thread, JSON.stringify({ status: "complete" })],
    )
  ).rows[0]!.id;
  const store = new PersonalPlan(db);
  const created = await store.create(owner, {
    operationId: randomUUID(),
    sourceMessageId: message,
    title: "Сравнить районы",
    details: "Сохранённый пользователем синтетический шаг",
  });

  const { upgrade18RewindSql } = (await import(
    new URL("../../../scripts/release-upgrade-18-smoke.mjs", import.meta.url)
      .href
  )) as { upgrade18RewindSql: () => string };
  const rewinds = [{ name: "schema18", sql: upgrade18RewindSql() }];
  for (const file of [
    "release-migration-smoke.mjs",
    "release-upgrade-12-smoke.mjs",
  ]) {
    const source = await readFile(
      new URL("../../../scripts/" + file, import.meta.url),
      "utf8",
    );
    const match =
      /psql\(\s*`(begin;\s*-- 0047 private memory[\s\S]*?commit)`/.exec(source);
    assert.ok(match, "Execute the exact static fixture SQL, not a second copy");
    assert.equal(match[1]!.includes("${"), false);
    rewinds.push({ name: file, sql: match[1]! });
  }

  for (const deleted of [false, true]) {
    if (deleted) await store.remove(owner, created.item.id, 1);
    const before = await snapshot(db);
    const page = await store.list(owner);
    assert.equal(page.items.length, deleted ? 0 : 1);
    assert.deepEqual(
      (
        await db.query<{ deleted: boolean }>(
          "select deleted_at is not null as deleted from personal_plan_items where id=$1",
          [created.item.id],
        )
      ).rows,
      [{ deleted }],
    );
    for (const rewind of rewinds) {
      await assert.rejects(
        db.exec(rewind.sql),
        /Personal plan history cannot be rewound/,
        `${rewind.name} must reject ${deleted ? "tombstoned" : "active"} plan history`,
      );
      await db.exec("rollback");
      assert.deepEqual(
        await snapshot(db),
        before,
        "Rejected rewind must roll back earlier admission DDL and retain plan/source/history/journal",
      );
      assert.deepEqual(await store.list(owner), page);
    }
  }
});

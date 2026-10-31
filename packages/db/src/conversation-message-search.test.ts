import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  ConversationMessageSearch,
  DomainError,
  type Database,
} from "./index.js";
async function seed(db: Database) {
  const user = async () =>
    (
      await db.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [randomUUID()],
      )
    ).rows[0]!.id;
  const owner = await user(),
    other = await user();
  const thread = async (u: string) =>
    (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,status)values($1,'support','closed')returning id::text",
        [u],
      )
    ).rows[0]!.id;
  const id = await thread(owner),
    foreign = await thread(other),
    sibling = await thread(owner);
  const insert = async (
    mid: string,
    tid = id,
    role = "user",
    content = "Начало " +
      "😀".repeat(90) +
      " МОСКВА 50%_\\route " +
      "Я".repeat(500),
  ) =>
    db.query(
      'insert into messages(id,thread_id,role,content,metadata)overriding system value values($1,$2,$3,$4,\'{"agentKey":"support","status":"complete"}\')',
      [mid, tid, role, content],
    );
  for (let i = 0; i < 25; i++)
    await insert(
      String(9007199254740993n + BigInt(i)),
      id,
      i % 2 ? "assistant" : "user",
    );
  await insert("9");
  await insert("9007199254741111", id, "system");
  await insert("9007199254741112", id, "tool");
  await insert("9007199254741113", foreign);
  await insert("9007199254741114", sibling);
  await insert("9007199254741115", id, "user", "Без совпадения");
  return { owner, other, id, foreign, insert };
}
async function snapshot(db: Database) {
  const data: Record<string, unknown> = {};
  for (const { table_name } of (
    await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
    )
  ).rows) {
    assert.match(table_name, /^[a-z_][a-z0-9_]*$/);
    data[table_name] = (
      await db.query<{ row: string }>(
        `select to_jsonb(t)::text as row from "${table_name}" t`,
      )
    ).rows
      .map((x) => x.row)
      .sort();
  }
  return {
    data,
    sequences: (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows,
  };
}
test("message search reads recent and old literal Unicode matches with bigint keysets while preserving every table and sequence", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const f = await seed(db),
    reader = new ConversationMessageSearch(db),
    before = await snapshot(db);
  const first = await reader.list(f.owner, f.id, {
    search: "москва 50%_\\route",
  });
  assert.equal(first.matches.length, 20);
  assert.equal(first.matches[0]!.messageId, "9007199254741017");
  assert.equal(first.nextCursor, "9007199254740998");
  assert(
    first.matches.every(
      (x) =>
        x.snippet.length <= 512 && x.snippet.includes("МОСКВА 50%_\\route"),
    ),
  );
  const second = await reader.list(f.owner, f.id, {
    search: first.search,
    before: first.nextCursor!,
  });
  assert.equal(second.matches.length, 6);
  assert.equal(second.matches.at(-1)!.messageId, "9");
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    reader.list(f.other, f.id, { search: first.search }),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  for (const cursor of [
    "9007199254741111",
    "9007199254741113",
    "9007199254741114",
    "9007199254741115",
  ])
    await assert.rejects(
      reader.list(f.owner, f.id, { search: first.search, before: cursor }),
      DomainError,
    );
  assert.equal(
    (await reader.list(f.owner, f.id, { search: "not-present" })).matches
      .length,
    0,
  );
  assert.deepEqual(await snapshot(db), before);
});
test("message search rechecks blocked and bootstrap owners before reading a conversation", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const f = await seed(db),
    reader = new ConversationMessageSearch(db);
  for (const sql of [
    "update users set status='blocked' where id=$1",
    "update users set status='active',must_change_password=true where id=$1",
  ]) {
    await db.query(sql, [f.owner]);
    await assert.rejects(
      reader.list(f.owner, f.id, { search: "Москва" }),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
  }
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  CONVERSATION_EXPORT_MAX_BYTES,
  CONVERSATION_EXPORT_MAX_MESSAGES,
} from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  exportConversation,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = async () =>
    (
      await db.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [randomUUID()],
      )
    ).rows[0]!.id;
  const owner = await user(),
    other = await user();
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const thread = async (u = owner) =>
    (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,status)values($1,'support','closed')returning id::text",
        [u],
      )
    ).rows[0]!.id;
  const id = await thread(),
    foreign = await thread(other);
  const add = async (
    mid: string,
    role = "user",
    content = "Полный текст 😀",
    tid = id,
    status = "complete",
    failureCode: string | null = null,
  ) =>
    db.query(
      "insert into messages(id,thread_id,role,content,metadata,created_at)overriding system value values($1,$2,$3,$4,$5::jsonb,$6)",
      [
        mid,
        tid,
        role,
        content,
        JSON.stringify({
          agentKey: "support",
          status,
          ...(failureCode ? { failureCode } : {}),
        }),
        BigInt(mid) % 2n ? "2026-12-01" : "2026-01-01",
      ],
    );
  return { db, owner, other, id, foreign, thread, add };
}
async function snapshot(db: Database) {
  const state: Record<string, unknown> = {};
  for (const { table_name } of (
    await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name",
    )
  ).rows) {
    assert.match(table_name, /^[a-z_][a-z0-9_]*$/);
    state[table_name] = (
      await db.query<{ row: string }>(
        `select to_jsonb(t)::text as row from "${table_name}" t`,
      )
    ).rows
      .map((x) => x.row)
      .sort();
  }
  state.sequences = (
    await db.query(
      "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
    )
  ).rows;
  return state;
}
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
test("export reads every old visible row in ID order under owner/thread locks without changing any table or sequence", async (t) => {
  const f = await fixture(t),
    base = 9007199254740991n;
  for (let n = 1; n <= 210; n++)
    await f.add(
      (base + BigInt(n)).toString(),
      n % 2 ? "user" : "assistant",
      "ЛИЧНЫЙ_ТЕКСТ_" + n + "😀\n" + "Полный текст ".repeat(25),
    );
  await f.add(
    (base + 211n).toString(),
    "assistant",
    "ПРЕРВАННЫЙ_ФРАГМЕНТ",
    f.id,
    "interrupted",
  );
  await f.add(
    (base + 212n).toString(),
    "assistant",
    "",
    f.id,
    "interrupted",
    "AI_CREDIT_EXHAUSTED",
  );
  await f.add("1", "system", "HIDDEN_SYSTEM");
  await f.add("2", "tool", "HIDDEN_TOOL");
  await f.add("3", "user", "FOREIGN_PRIVATE", f.foreign);
  const before = await snapshot(f.db),
    statements: string[] = [];
  const observe = (tx: Sql): Sql => ({
    exec: async () => assert.fail("Export must not execute commands"),
    query: (sql, params) => {
      statements.push(sql);
      assert.match(sql.trim(), /^(select|with)\b/i);
      return tx.query(sql, params);
    },
  });
  const guarded: Database = {
    ...f.db,
    transaction: (work) => f.db.transaction((tx) => work(observe(tx))),
  };
  const value = await exportConversation(guarded, f.owner, f.id);
  assert.equal(statements.length, 3);
  assert.match(statements[0]!, /from users.*for share/);
  assert.match(statements[1]!, /agent_threads.*user_id=\$1 for share/);
  assert.match(statements[2]!, /with visible as materialized/);
  assert.equal(value.messages.length, 212);
  assert.deepEqual(
    value.messages.map((m) => m.id),
    Array.from({ length: 212 }, (_, n) => (base + BigInt(n + 1)).toString()),
  );
  assert.ok(value.messages[0]!.content.includes("ЛИЧНЫЙ_ТЕКСТ_1😀"));
  assert.equal(value.messages.at(-1)!.failureCode, "AI_CREDIT_EXHAUSTED");
  assert.equal(value.messages.at(-2)!.status, "interrupted");
  assert.equal(value.thread.closed, true);
  assert(!JSON.stringify(value).includes("HIDDEN"));
  assert(!JSON.stringify(value).includes("FOREIGN_PRIVATE"));
  assert.deepEqual(await snapshot(f.db), before);
});
test("closed/empty ownership is explicit, including super admin; blocked/bootstrap owners and malformed IDs cannot export", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    (await exportConversation(f.db, f.owner, f.id)).messages,
    [],
  );
  await assert.rejects(exportConversation(f.db, f.other, f.id), status(404));
  await assert.rejects(
    exportConversation(f.db, f.owner, f.foreign),
    status(404),
  );
  await assert.rejects(
    exportConversation(f.db, f.owner, "9223372036854775807"),
    status(404),
  );
  await f.db.query("update users set status='blocked' where id=$1", [f.owner]);
  await assert.rejects(exportConversation(f.db, f.owner, f.id), status(403));
  await f.db.query(
    "update users set status='active',must_change_password=true where id=$1",
    [f.owner],
  );
  await assert.rejects(exportConversation(f.db, f.owner, f.id), status(403));
  for (const invalid of ["0", "01", "1\n", "9223372036854775808", "../admin"]) {
    await assert.rejects(exportConversation(f.db, f.owner, invalid));
    await assert.rejects(exportConversation(f.db, invalid, f.id));
  }
});
test("row and raw/escaped aggregate byte limits explicitly refuse the whole export instead of truncating", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "insert into messages(thread_id,role,content)select $1,'user','bounded' from generate_series(1,$2)",
    [f.id, CONVERSATION_EXPORT_MAX_MESSAGES + 1],
  );
  await assert.rejects(exportConversation(f.db, f.owner, f.id), status(413));
  const large = await f.thread();
  await f.add(
    "9007199254745000",
    "user",
    "Я".repeat(CONVERSATION_EXPORT_MAX_BYTES / 2 + 1),
    large,
  );
  await assert.rejects(exportConversation(f.db, f.owner, large), status(413));
  const escaped = await f.thread();
  for (let n = 0; n < 6; n++)
    await f.add(
      String(9007199254746000n + BigInt(n)),
      "user",
      "\n".repeat(900000),
      escaped,
    );
  await assert.rejects(exportConversation(f.db, f.owner, escaped), status(413));
});
test("invalid persisted message metadata fails generically with no partial private export", async (t) => {
  const f = await fixture(t);
  await f.add("1", "assistant", "PRIVATE_NEVER_EXPOSE", f.id, "running");
  await assert.rejects(
    exportConversation(f.db, f.owner, f.id),
    (error) =>
      status(500)(error) && !(error as Error).message.includes("PRIVATE"),
  );
});

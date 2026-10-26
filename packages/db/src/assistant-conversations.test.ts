import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { agentKeys, conversationListResponseSchema } from "@citygo/contracts";
import {
  connectDatabase,
  ensureConversation,
  migrate,
  Repository,
  DomainError,
  type Database,
} from "./index.js";

async function fixture(t: TestContext, latest = true) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  if (latest) await migrate(db);
  return db;
}
async function user(db: Database) {
  return (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values($1) returning id::text",
      [randomUUID()],
    )
  ).rows[0]!.id;
}
async function counts(db: Database) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "relocation_profiles",
    "questionnaire_answers",
    "relocation_plans",
    "user_quests",
    "messages",
    "ai_model_attempts",
    "ai_credit_accounts",
    "ai_credit_entries",
    "ai_credit_charges",
    "payment_topup_orders",
    "payment_refunds",
    "consent_events",
    "xp_events",
  ])
    result[table] = (
      await db.query(`select count(*)::int as n from ${table}`)
    ).rows;
  return result;
}

test("each assistant resumes its own conversation without moving legacy history or creating AI/money state", async (t) => {
  const db = await fixture(t),
    owner = await user(db),
    other = await user(db);
  const repo = new Repository(db);
  const legacy = await ensureConversation(db, owner);
  await db.query(
    "insert into messages(thread_id,role,content) values($1,'user','LEGACY ONLY')",
    [legacy.id],
  );
  const before = await counts(db);
  const threads = await Promise.all(
    agentKeys.map((key) => ensureConversation(db, owner, key)),
  );
  assert.equal(new Set(threads.map((value) => value.id)).size, 5);
  assert.ok(threads.every((value) => value.id !== legacy.id));
  for (const [index, key] of agentKeys.entries()) {
    const thread = threads[index]!;
    assert.deepEqual(thread, {
      id: thread.id,
      agentKey: key,
      assistantKey: key,
      closed: false,
    });
    assert.deepEqual(await ensureConversation(db, owner, key), thread);
    const detail = await repo.conversation(owner, thread.id);
    assert.equal(detail.userId, owner);
    assert.equal(detail.thread.messages.length, 0);
    const foreign = await ensureConversation(db, other, key);
    assert.notEqual(foreign.id, thread.id);
    await assert.rejects(
      repo.conversation(other, thread.id),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 404,
    );
  }
  assert.deepEqual(await ensureConversation(db, owner), legacy);
  assert.equal(
    (await repo.conversation(owner, legacy.id)).thread.messages[0]!.content,
    "LEGACY ONLY",
  );
  assert.deepEqual(await counts(db), before);
});

test("pinned identity cannot be changed by a paired role update, while legacy routing and closed history remain usable", async (t) => {
  const db = await fixture(t),
    owner = await user(db),
    other = await user(db);
  const pinned = await ensureConversation(db, owner, "housing");
  for (const change of [
    "agent_key='support'",
    "conversation_agent_key='support',agent_key='support'",
    "conversation_agent_key=null",
    `user_id=${other}`,
    "id=default",
  ])
    await assert.rejects(
      db.query(`update agent_threads set ${change} where id=$1`, [pinned.id]),
      { code: "23514" },
    );
  await assert.rejects(
    db.query(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','bubble')",
      [owner],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    db.query(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'housing','housing')",
      [owner],
    ),
    { code: "23505" },
  );
  await db.query(
    "insert into messages(thread_id,role,content,metadata) values($1,'assistant','HOUSING ONLY',$2)",
    [
      pinned.id,
      JSON.stringify({
        agentKey: "housing",
        status: "complete",
        citygoFavorite: true,
      }),
    ],
  );
  await db.query("update agent_threads set status='closed' where id=$1", [
    pinned.id,
  ]);
  const closed = (await new Repository(db).conversation(owner, pinned.id))
    .thread;
  assert.equal(closed.closed, true);
  assert.equal(closed.assistantKey, "housing");
  assert.equal(closed.messages[0]!.favorite, true);
  const replacement = await ensureConversation(db, owner, "housing");
  assert.notEqual(replacement.id, pinned.id);
  const legacy = await ensureConversation(db, owner);
  await db.query(
    "update agent_threads set agent_key='job-search' where id=$1",
    [legacy.id],
  );
  assert.equal((await ensureConversation(db, owner)).agentKey, "job-search");
  await assert.rejects(
    db.query(
      "update agent_threads set conversation_agent_key='job-search' where id=$1",
      [legacy.id],
    ),
    { code: "23514" },
  );
});

test("owner-scoped conversation pages keep exact bigint ordering, whole Unicode previews and no foreign/system contents", async (t) => {
  const db = await fixture(t),
    owner = await user(db),
    other = await user(db),
    repo = new Repository(db);
  const ids = Array.from({ length: 43 }, (_, index) =>
    String(9007199254740993n + BigInt(index)),
  );
  for (const id of ids)
    await db.query(
      "insert into agent_threads(id,user_id,agent_key,status) overriding system value values($1,$2,'support','closed')",
      [id, owner],
    );
  const foreign = "9223372036854775807";
  await db.query(
    "insert into agent_threads(id,user_id,agent_key,status) overriding system value values($1,$2,'support','closed')",
    [foreign, other],
  );
  await db.query(
    "insert into messages(thread_id,role,content) values($1,'user',$2),($1,'system','SYSTEM SECRET'),($1,'tool','TOOL SECRET')",
    [ids.at(-1), "🧳".repeat(240)],
  );
  await db.query(
    "insert into messages(thread_id,role,content) values($1,'user','FOREIGN SECRET')",
    [foreign],
  );
  const all: string[] = [];
  let before: string | undefined;
  const sizes: number[] = [];
  do {
    const page = await repo.conversations(owner, before);
    assert.equal(page.userId, owner);
    conversationListResponseSchema.parse(page);
    sizes.push(page.conversations.length);
    all.push(...page.conversations.map((item) => item.id));
    assert.ok(!JSON.stringify(page).includes("SECRET"));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32000);
    if (!before) {
      assert.equal(page.conversations[0]!.preview, "🧳".repeat(120));
      assert.equal(page.conversations[0]!.closed, true);
    }
    before = page.nextCursor ?? undefined;
  } while (before);
  assert.deepEqual(sizes, [20, 20, 3]);
  assert.deepEqual(all, [...ids].reverse());
  assert.equal(new Set(all).size, ids.length);
  await assert.rejects(
    repo.conversation(owner, foreign),
    (error: unknown) =>
      error instanceof DomainError && error.statusCode === 404,
  );
});

test("legacy dashboard and quest start do not select or overwrite separate assistant conversations", async (t) => {
  const db = await fixture(t),
    repo = new Repository(db);
  const owner = await repo.register(
    "synthetic-assistants@example.test",
    "synthetic",
  );
  const pinned = await Promise.all(
    agentKeys.map((key) => ensureConversation(db, owner, key)),
  );
  const legacy = await ensureConversation(db, owner);
  await db.query(
    "insert into messages(thread_id,role,content) values($1,'user','COMMON HISTORY')",
    [legacy.id],
  );
  await repo.questionnaire(owner, {
    originCity: "Тестовый",
    targetCity: "Москва",
    monthlyBudget: 50000,
    household: "solo",
    moveTargetDate: "2099-01-01",
    aiConsent: true,
  });
  const board = await repo.dashboard(
    { id: owner, email: "synthetic-assistants@example.test" },
    "unconfigured",
    null,
    0,
  );
  assert.equal(board.thread!.id, legacy.id);
  const started = await repo.start(owner, board.quests[0]!.id);
  assert.equal(started.id, legacy.id);
  for (const thread of pinned) {
    const actual = await repo.conversation(owner, thread.id);
    assert.equal(actual.thread.agentKey, thread.assistantKey);
    assert.deepEqual(actual.thread.messages, []);
  }
});

test("24→25 preserves legacy rows, leases, all financial tables and original migration receipts", async (t) => {
  const db = await fixture(t, false);
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.equal(names.length, 34);
  assert.equal(names[24], "0025_assistant_conversations.sql");
  assert.equal(names.at(-1), "0034_gigachat_request_fees.sql");
  await db.exec(
    "create table citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1); create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of names.slice(0, 24)) {
    const source = await readFile(new URL(name, directory), "utf8");
    await db.exec(
      source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
    );
    await db.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [
        name,
        createHash("sha256")
          .update(source.replaceAll("\r\n", "\n"))
          .digest("hex"),
      ],
    );
  }
  const owner = await user(db);
  const legacy = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,busy_until,lease_token) values($1,'job-search','2099-01-01',$2) returning id::text",
      [owner, randomUUID()],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content,metadata) values($1,'assistant','EXACT HISTORY',$2)",
    [
      legacy,
      JSON.stringify({
        agentKey: "job-search",
        status: "interrupted",
        citygoFavorite: true,
      }),
    ],
  );
  await db.query("insert into ai_credit_accounts(user_id) values($1)", [owner]);
  const tables = (
    await db.query<{ name: string }>(
      "select tablename as name from pg_tables where schemaname='public' order by tablename",
    )
  ).rows.map((row) => row.name);
  const snapshot = async (after: boolean) => {
    const values: Record<string, unknown> = {};
    for (const table of tables) {
      assert.match(table, /^[a-z_][a-z0-9_]*$/);
      const expression =
        table === "agent_threads" && after
          ? "to_jsonb(t)-'conversation_agent_key'"
          : "to_jsonb(t)";
      values[table] = (
        await db.query(
          `select ${expression} as value from ${table} t ${table === "citygo_migrations" && after ? "where name<'0025'" : ""} order by (${expression})::text`,
        )
      ).rows;
    }
    return values;
  };
  const before = await snapshot(false);
  await migrate(db);
  assert.deepEqual(await snapshot(true), before);
  assert.deepEqual(
    (
      await db.query(
        "select conversation_agent_key from agent_threads where id=$1",
        [legacy],
      )
    ).rows,
    [{ conversation_agent_key: null }],
  );
  assert.deepEqual(await ensureConversation(db, owner), {
    id: legacy,
    agentKey: "job-search",
  });
});

test("invalid owners, assistant choices and cursors fail before storage access", async () => {
  let touched = false;
  const fail = async (): Promise<never> => {
    touched = true;
    throw new Error("No I/O");
  };
  const db: Database = {
    query: fail,
    transaction: fail,
    exec: fail,
    close: async () => {},
  };
  const repo = new Repository(db);
  for (const bad of ["0", "01", "9223372036854775808", "1;select 1"]) {
    await assert.rejects(repo.conversation("1", bad), DomainError);
    await assert.rejects(repo.conversations("1", bad), DomainError);
    await assert.rejects(ensureConversation(db, bad, "housing"), DomainError);
  }
  await assert.rejects(
    ensureConversation(db, "1", "bubble" as never),
    DomainError,
  );
  assert.equal(touched, false);
});

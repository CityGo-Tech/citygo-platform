import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  conversationMessagesResponseSchema,
  type Message,
} from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  ensureConversation,
  type Database,
} from "./index.js";
import { Repository, DomainError } from "./repository.js";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const users = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values($1),($2),($3) returning id::text",
      [randomUUID(), randomUUID(), randomUUID()],
    )
  ).rows.map((row) => row.id);
  const owner = users[0]!,
    other = users[1]!,
    admin = users[2]!;
  await db.query("update users set role='super_admin' where id=$1", [admin]);
  const thread = await ensureConversation(db, owner, "housing");
  const sibling = await ensureConversation(db, owner, "support");
  const foreign = await ensureConversation(db, other, "housing");
  return {
    db,
    owner,
    other,
    admin,
    thread: thread.id,
    sibling: sibling.id,
    foreign: foreign.id,
    repo: new Repository(db),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function insert(
  f: Fixture,
  id: string,
  role: Message["role"] | "system" | "tool" = "assistant",
  thread = f.thread,
  metadata: Record<string, unknown> = {},
) {
  const content = "Synthetic history " + id;
  await f.db.query(
    "insert into messages(id,thread_id,role,content,metadata) overriding system value values($1,$2,$3,$4,$5)",
    [id, thread, role, content, JSON.stringify(metadata)],
  );
  return {
    id,
    role,
    content,
    agentKey: metadata.agentKey ?? "housing",
    status: metadata.status ?? "complete",
    generation: metadata.generation ?? null,
    failureCode: metadata.failureCode ?? null,
    favorite: metadata.citygoFavorite === true,
  };
}
const notFound = (error: unknown) =>
  error instanceof DomainError &&
  error.statusCode === 404 &&
  error.message === "Чат не найден";

test("exact message context reaches old favorites and int64 maximum without changing the latest reader", async (t) => {
  const f = await fixture(t);
  const base = 9223372036854775500n;
  await f.db.query(
    `insert into messages(id,thread_id,role,content) overriding system value
     select $1::bigint+i,$2,'user','Synthetic context '||i::text
     from generate_series(1,205) as i`,
    [base.toString(), f.thread],
  );
  const target = (base + 103n).toString();
  const page = await f.repo.conversationMessageContext(
    f.owner,
    f.thread,
    target,
  );
  conversationMessagesResponseSchema.parse(page);
  assert.equal(page.messages.length, 100);
  assert.equal(page.messages[0]!.id, (base + 4n).toString());
  assert.equal(page.messages.at(-1)!.id, target);
  assert.equal(page.nextCursor, page.messages[0]!.id);
  assert.ok(
    !(await f.repo.conversation(f.owner, f.thread)).thread.messages.some(
      (row) => row.id === target,
    ),
    "the chosen old message is outside the unchanged latest100 reader",
  );
  const older = await f.repo.conversationMessages(
    f.owner,
    f.thread,
    page.nextCursor!,
  );
  assert.deepEqual(
    older.messages.map((row) => row.id),
    [1n, 2n, 3n].map((i) => (base + i).toString()),
  );
  assert.equal(older.nextCursor, null);
  await insert(f, "9223372036854775807");
  const maximum = await f.repo.conversationMessageContext(
    f.owner,
    f.thread,
    "9223372036854775807",
  );
  assert.equal(maximum.messages.at(-1)!.id, "9223372036854775807");
  assert.equal(maximum.messages.length, 100);
});

test("context requires the exact visible source in the owned thread, including closed history", async (t) => {
  const f = await fixture(t);
  await insert(f, "1", "user");
  await insert(f, "2", "assistant");
  await insert(f, "3", "system");
  await insert(f, "4", "tool");
  await insert(f, "5", "user", f.sibling);
  await insert(f, "6", "assistant", f.foreign);
  for (const source of ["3", "4", "5", "6", "7"])
    await assert.rejects(
      f.repo.conversationMessageContext(f.owner, f.thread, source),
      notFound,
    );
  for (const requester of [f.other, f.admin])
    await assert.rejects(
      f.repo.conversationMessageContext(requester, f.thread, "1"),
      notFound,
    );
  await f.db.query("update agent_threads set status='closed' where id=$1", [
    f.thread,
  ]);
  const page = await f.repo.conversationMessageContext(f.owner, f.thread, "1");
  assert.deepEqual(
    page.messages.map((row) => row.id),
    ["1"],
  );
  assert.equal(page.nextCursor, null);
});

test("invalid context IDs fail before storage or bigint normalization", async () => {
  let reads = 0;
  const denied = async (): Promise<never> => {
    reads++;
    throw Error("Unexpected storage");
  };
  const repo = new Repository({
    query: denied,
    exec: denied,
    transaction: denied,
    close: async () => {},
  });
  for (const bad of [
    "",
    "01",
    "1\n",
    " 1",
    "9223372036854775808",
    1,
    null,
    undefined,
  ])
    for (const args of [
      [bad, "1", "1"],
      ["1", bad, "1"],
      ["1", "1", bad],
    ])
      await assert.rejects(
        repo.conversationMessageContext(...(args as [string, string, string])),
        (error) => error instanceof DomainError && error.statusCode === 400,
      );
  assert.equal(reads, 0);
});

test("message pages traverse over 250 visible messages by exact numeric ID despite timestamps, interleaved roles and foreign messages", async (t) => {
  const f = await fixture(t),
    base = 9007199254740991n;
  await f.db.query(
    `insert into messages(id,thread_id,role,content,metadata,created_at) overriding system value
     select $1::bigint+i,$2::bigint,
      case when i%6=0 then 'tool' when i%6=3 then 'system' when i%2=0 then 'assistant' else 'user' end,
      'Synthetic message '||i::text,'{}'::jsonb,
      case when i%2=0 then '2026-01-01'::timestamptz else '2026-12-01'::timestamptz end
     from generate_series(1,390) as i`,
    [base.toString(), f.thread],
  );
  await insert(f, (base + 1000n).toString(), "user", f.foreign);
  await insert(f, (base + 1001n).toString(), "assistant", f.sibling);
  const expected = Array.from({ length: 390 }, (_, i) => i + 1)
    .filter((i) => i % 6 !== 0 && i % 6 !== 3)
    .map((i) => (base + BigInt(i)).toString());
  const pages = [],
    all: string[] = [];
  let before: string | undefined;
  do {
    const page = await f.repo.conversationMessages(f.owner, f.thread, before);
    conversationMessagesResponseSchema.parse(page);
    assert.equal(page.userId, f.owner);
    assert.equal(page.threadId, f.thread);
    if (before)
      assert.ok(
        page.messages.every((message) => BigInt(message.id) < BigInt(before!)),
      );
    if (page.nextCursor) assert.equal(page.nextCursor, page.messages[0]!.id);
    pages.push(page.messages.length);
    all.unshift(...page.messages.map((message) => message.id));
    before = page.nextCursor ?? undefined;
  } while (before);
  assert.deepEqual(pages, [100, 100, 60]);
  assert.deepEqual(all, expected);
  assert.equal(new Set(all).size, 260);
  // The older screen is not a change to the last-100 detail/AI reader.
  assert.deepEqual(
    (await f.repo.history(f.db, f.thread)).map((message) => message.id),
    expected.slice(-100),
  );
  assert.deepEqual(
    (await f.repo.conversation(f.owner, f.thread)).thread.messages.map(
      (message) => message.id,
    ),
    expected.slice(-100),
  );
});

test("empty, exact-100 and 101-lookahead pages have honest cursors, including the oldest visible cursor", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.repo.conversationMessages(f.owner, f.thread), {
    userId: f.owner,
    threadId: f.thread,
    messages: [],
    nextCursor: null,
  });
  await f.db.query(
    "insert into messages(id,thread_id,role,content) overriding system value select i,$1,'user','Synthetic '||i::text from generate_series(1,100) as i",
    [f.thread],
  );
  const exact = await f.repo.conversationMessages(f.owner, f.thread);
  assert.equal(exact.messages.length, 100);
  assert.equal(exact.nextCursor, null);
  await insert(f, "101");
  const latest = await f.repo.conversationMessages(f.owner, f.thread);
  assert.equal(latest.messages.length, 100);
  assert.equal(latest.messages[0]!.id, "2");
  assert.equal(latest.nextCursor, "2");
  const oldest = await f.repo.conversationMessages(
    f.owner,
    f.thread,
    latest.nextCursor!,
  );
  assert.deepEqual(
    oldest.messages.map((message) => message.id),
    ["1"],
  );
  assert.equal(oldest.nextCursor, null);
  assert.deepEqual(
    (await f.repo.conversationMessages(f.owner, f.thread, "1")).messages,
    [],
  );
});

test("cursor must be a visible message in this exact owned thread; admins do not bypass ownership and closed chats remain readable", async (t) => {
  const f = await fixture(t);
  await insert(f, "1", "user");
  await insert(f, "2");
  await insert(f, "3", "system");
  await insert(f, "4", "tool");
  await insert(f, "5", "user", f.sibling);
  await insert(f, "6", "assistant", f.foreign);
  for (const cursor of ["3", "4", "5", "6", "9223372036854775807"])
    await assert.rejects(
      f.repo.conversationMessages(f.owner, f.thread, cursor),
      notFound,
    );
  for (const requester of [f.other, f.admin]) {
    await assert.rejects(
      f.repo.conversationMessages(requester, f.thread),
      notFound,
    );
    await assert.rejects(
      f.repo.conversationMessages(requester, f.thread, "1"),
      notFound,
    );
  }
  await assert.rejects(
    f.repo.conversationMessages(f.owner, "9223372036854775807"),
    notFound,
  );
  await f.db.query("update agent_threads set status='closed' where id=$1", [
    f.thread,
  ]);
  assert.deepEqual(
    (await f.repo.conversationMessages(f.owner, f.thread)).messages.map(
      (message) => message.id,
    ),
    ["1", "2"],
  );
  assert.deepEqual(
    (await f.repo.conversationMessages(f.owner, f.thread, "2")).messages.map(
      (message) => message.id,
    ),
    ["1"],
  );
});

test("saved metadata and all persisted rows remain unchanged by successful pages and rejected cursors", async (t) => {
  const f = await fixture(t);
  const generation = {
    provider: "routerai",
    requestedModel: "synthetic/model",
    model: "synthetic/model",
    usage: { inputTokens: 12, outputTokens: 34 },
  };
  const complete = await insert(f, "1", "assistant", f.thread, {
    agentKey: "housing",
    generation,
    citygoFavorite: true,
  });
  const refused = await insert(f, "2", "assistant", f.thread, {
    agentKey: "support",
    status: "interrupted",
    failureCode: "AI_CREDIT_EXHAUSTED",
  });
  await f.db.query("insert into ai_credit_accounts(user_id) values($1)", [
    f.owner,
  ]);
  const snapshot = async () => {
    const result: Record<string, unknown> = {};
    const tables = (
      await f.db.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname='public' order by tablename",
      )
    ).rows;
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
      result[tablename] = (
        await f.db.query(
          `select to_jsonb(t)::text as value from ${tablename} t order by to_jsonb(t)::text`,
        )
      ).rows;
    }
    for (const { sequencename } of (
      await f.db.query<{ sequencename: string }>(
        "select sequencename from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows) {
      assert.match(sequencename, /^[a-z_][a-z0-9_]*$/);
      result["sequence:" + sequencename] = (
        await f.db.query(
          `select last_value::text,is_called from ${sequencename}`,
        )
      ).rows;
    }
    return result;
  };
  const before = await snapshot();
  const page = await f.repo.conversationMessages(f.owner, f.thread);
  conversationMessagesResponseSchema.parse(page);
  assert.deepEqual(page.messages, [complete, refused]);
  await f.repo.conversationMessages(f.owner, f.thread, "2");
  await assert.rejects(
    f.repo.conversationMessages(f.admin, f.thread),
    notFound,
  );
  await assert.rejects(
    f.repo.conversationMessages(f.owner, f.thread, "3"),
    notFound,
  );
  assert.deepEqual(await snapshot(), before);
});

test("invalid owner, conversation and cursor IDs fail before any storage access", async () => {
  let touched = false;
  const fail = async (): Promise<never> => {
    touched = true;
    throw new Error("No storage expected");
  };
  const db: Database = {
    query: fail,
    transaction: fail,
    exec: fail,
    close: async () => {},
  };
  const repo = new Repository(db);
  for (const id of [
    "0",
    "01",
    "-1",
    "1.0",
    "1e2",
    " 1",
    "1\n",
    "9223372036854775808",
    "1;select 1",
    1,
    null,
    {},
  ]) {
    for (const args of [
      [id, "1"],
      ["1", id],
      ["1", "1", id],
    ])
      await assert.rejects(
        repo.conversationMessages(...(args as [string, string, string?])),
        (error) => error instanceof DomainError && error.statusCode === 400,
      );
  }
  assert.equal(touched, false);
});

test("owner active/password state is rechecked under its share lock before any history query", async (t) => {
  const f = await fixture(t);
  await insert(f, "1");
  for (const status of ["blocked", "deleted"]) {
    await f.db.query("update users set status=$2 where id=$1", [
      f.owner,
      status,
    ]);
    await assert.rejects(
      f.repo.conversationMessages(f.owner, f.thread),
      (error) => error instanceof DomainError && error.statusCode === 403,
    );
  }
  await f.db.query(
    "update users set status='active',must_change_password=true where id=$1",
    [f.owner],
  );
  await assert.rejects(
    f.repo.conversationMessages(f.owner, f.thread),
    (error) => error instanceof DomainError && error.statusCode === 403,
  );
  await f.db.query("update users set must_change_password=false where id=$1", [
    f.owner,
  ]);
  assert.equal(
    (await f.repo.conversationMessages(f.owner, f.thread)).messages[0]!.id,
    "1",
  );
});

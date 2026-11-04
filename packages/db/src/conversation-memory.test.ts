import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  migrate,
  ensureConversation,
  ConversationMemory,
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  type Database,
} from "./index.js";
import { indexConversationMemoryMessage } from "./conversation-memory.js";
import { Repository, DomainError } from "./repository.js";
import {
  CONVERSATION_PAGE_CONTENT_BYTES,
  CONVERSATION_CONTEXT_CONTENT_BYTES,
} from "./bounded-conversation-messages.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const users = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject)values($1),($2) returning id::text",
      [randomUUID(), randomUUID()],
    )
  ).rows;
  const owner = users[0]!.id,
    other = users[1]!.id,
    thread = (await ensureConversation(db, owner, "housing")).id,
    sibling = (await ensureConversation(db, owner, "support")).id,
    foreign = (await ensureConversation(db, other, "housing")).id;
  return {
    db,
    owner,
    other,
    thread,
    sibling,
    foreign,
    store: new ConversationMemory(db),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function message(
  f: Fixture,
  content: string,
  options: { thread?: string; role?: string; status?: string } = {},
) {
  return (
    await f.db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata)values($1,$2,$3,$4) returning id::text",
      [
        options.thread ?? f.thread,
        options.role ?? "user",
        content,
        JSON.stringify({ status: options.status ?? "complete" }),
      ],
    )
  ).rows[0]!.id;
}

test("persistent memory quotes original user facts and latest corrections outside the latest history, never assistant assertions", async (t) => {
  const f = await fixture(t),
    original = await message(
      f,
      "Работаю на Кутузовском проспекте. Бюджет 80000 рублей.",
    ),
    assistant = await message(f, "ПОЛНОСТЬЮ ВЫДУМАННЫЙ ФАКТ: бюджет 900000", {
      role: "assistant",
    });
  for (let i = 0; i < 125; i++) await message(f, `Промежуточный вопрос ${i}`);
  const correction = await message(
      f,
      "Исправляю бюджет: теперь 95000 рублей. Работа на Кутузовском проспекте.",
    ),
    current = await message(f, "Что я сообщал о работе и бюджете?");
  const first = await f.store.snapshot(
    f.owner,
    f.thread,
    "работа Кутузовский бюджет",
    { beforeMessageId: current },
  );
  assert.equal(first.complete, false);
  assert.equal(first.indexComplete, false);
  assert.ok(first.fragments.some((part) => part.messageId === original));
  assert.ok(first.fragments.some((part) => part.messageId === correction));
  assert.ok(
    !first.fragments.some((part) =>
      [assistant, current].includes(part.messageId),
    ),
  );
  assert.ok(
    first.fragments.findIndex((part) => part.messageId === correction) <
      first.fragments.findIndex((part) => part.messageId === original),
  );
  for (let i = 0; i < 12; i++)
    await f.store.snapshot(f.owner, f.thread, "бюджет", {
      beforeMessageId: current,
    });
  const persisted = await new ConversationMemory(f.db).snapshot(
    f.owner,
    f.thread,
    "Кутузовский бюджет",
    { beforeMessageId: current },
  );
  assert.equal(persisted.indexComplete, true);
  assert.equal(persisted.complete, false);
  assert.equal(persisted.indexedMessages, 127);
  assert.ok(persisted.fragments.some((part) => part.messageId === original));
  assert.ok(
    !(await new Repository(f.db).history(f.db, f.thread)).some(
      (part) => part.id === original,
    ),
  );
});

test("Unicode fragments are exact source quotations, bounded, idempotent and complete only when all parts are selected", async (t) => {
  const f = await fixture(t),
    text = "😀Ж中".repeat(2400),
    id = await message(f, text);
  const result = await f.store.snapshot(f.owner, f.thread, "Ж中");
  assert.equal(result.indexComplete, true);
  assert.equal(result.complete, true);
  assert.equal(result.indexedMessages, 1);
  assert.equal(result.fragments.length, 8);
  const ordered = [...result.fragments].sort((a, b) => a.start - b.start);
  assert.equal(ordered.map((part) => part.content).join(""), text);
  for (const part of result.fragments) {
    assert.equal(part.messageId, id);
    assert.equal(part.sourceSha256, sha(text));
    assert.equal(
      part.content,
      Array.from(text).slice(part.start, part.end).join(""),
    );
    assert.ok(Array.from(part.content).length <= 1000);
    assert.ok(Buffer.byteLength(part.content) <= 4000);
  }
  const before = (
    await f.db.query(
      "select * from conversation_memory_fragments order by ordinal",
    )
  ).rows;
  await f.store.snapshot(f.owner, f.thread, "Ж中");
  assert.deepEqual(
    (
      await f.db.query(
        "select * from conversation_memory_fragments order by ordinal",
      )
    ).rows,
    before,
  );
  const long = await message(f, "я".repeat(100_000));
  const bounded = await f.store.snapshot(f.owner, f.thread, "я");
  assert.equal(bounded.indexComplete, true);
  assert.equal(bounded.complete, false);
  assert.ok(bounded.fragments.length <= 32);
  assert.ok(
    bounded.fragments.reduce(
      (sum, part) => sum + Buffer.byteLength(part.content),
      0,
    ) <= 128_000,
  );
  assert.ok(
    bounded.fragments.some(
      (part) => part.messageId === long && part.end === 100_000,
    ),
  );
});

test("memory is private by user and thread, and incomplete/system/tool/assistant sources are never indexed", async (t) => {
  const f = await fixture(t),
    owned = await message(f, "МОЙ ИСТОЧНИК"),
    foreign = await message(f, "ЧУЖОЙ ИСТОЧНИК", { thread: f.foreign }),
    sibling = await message(f, "ДРУГОЙ ДИАЛОГ", { thread: f.sibling });
  for (const role of ["assistant", "system", "tool"])
    await message(f, role + " SECRET", { role });
  await message(f, "INCOMPLETE SECRET", { status: "interrupted" });
  const memory = await f.store.snapshot(f.owner, f.thread, "источник");
  assert.deepEqual(
    memory.fragments.map((part) => part.messageId),
    [owned],
  );
  const absent = (error: unknown) =>
    error instanceof DomainError && error.statusCode === 404;
  await assert.rejects(f.store.snapshot(f.other, f.thread, "источник"), absent);
  await assert.rejects(
    f.store.snapshot(f.owner, f.foreign, "источник"),
    absent,
  );
  for (const cursor of [foreign, sibling])
    await assert.rejects(
      f.store.snapshot(f.owner, f.thread, "источник", {
        beforeMessageId: cursor,
      }),
      absent,
    );
  await f.db.query("update users set status='blocked' where id=$1", [f.owner]);
  await assert.rejects(
    f.store.snapshot(f.owner, f.thread, "источник"),
    (error: unknown) =>
      error instanceof DomainError && error.statusCode === 403,
  );
});

test("source guard rejects invented quotations and forgery; changed originals rebuild append-only without blocking chat", async (t) => {
  const f = await fixture(t),
    text = "Настоящее исходное сообщение",
    id = await message(f, text);
  const insert = (changes: Record<string, unknown> = {}) => {
    const value = {
      message: id,
      ordinal: 0,
      owner: f.owner,
      thread: f.thread,
      hash: sha(text),
      start: 0,
      end: Array.from(text).length,
      content: text,
      ...changes,
    };
    return f.db.query(
      "insert into conversation_memory_fragments(message_id,ordinal,user_id,thread_id,source_sha256,start_offset,end_offset,content)values($1,$2,$3,$4,$5,$6,$7,$8)",
      Object.values(value),
    );
  };
  for (const changes of [
    { owner: f.other },
    { thread: f.sibling },
    { hash: "a".repeat(64) },
    { content: "Выдуманное сообщение" },
    { start: 1 },
    { end: 3 },
  ])
    await assert.rejects(insert(changes));
  assert.equal(
    (await f.db.query("select * from conversation_memory_fragments")).rows
      .length,
    0,
  );
  await insert();
  await assert.rejects(
    f.db.query(
      "update conversation_memory_fragments set content='Подмена' where message_id=$1",
      [id],
    ),
  );
  await f.db.query(
    "update messages set content='Повреждённый оригинал' where id=$1",
    [id],
  );
  const rebuilt = await f.store.snapshot(f.owner, f.thread, "оригинал");
  assert.equal(rebuilt.indexComplete, true);
  assert.equal(rebuilt.complete, true);
  assert.deepEqual(
    rebuilt.fragments.map((part) => part.content),
    ["Повреждённый оригинал"],
  );
  assert.equal(
    (
      await f.db.query(
        "select * from conversation_memory_fragments where message_id=$1",
        [id],
      )
    ).rows.length,
    2,
  );
});

test("index insertion participates in the source transaction and cascades only with its exact source", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.db.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          "insert into messages(thread_id,role,content)values($1,'user','rollback source')returning id::text",
          [f.thread],
        )
      ).rows[0]!;
      assert.equal(
        await indexConversationMemoryMessage(tx, f.owner, f.thread, row.id),
        1,
      );
      throw new Error("rollback fixture");
    }),
    /rollback fixture/,
  );
  assert.equal(
    (await f.db.query("select * from conversation_memory_fragments")).rows
      .length,
    0,
  );
  const id = await message(f, "Точный источник");
  await f.store.snapshot(f.owner, f.thread, "источник");
  await f.db.query("delete from messages where id=$1", [id]);
  assert.equal(
    (await f.db.query("select * from conversation_memory_fragments")).rows
      .length,
    0,
  );
});

test("read-only memory preview never backfills or writes and reports unindexed sources honestly", async (t) => {
  const f = await fixture(t),
    id = await message(f, "Ещё не индексированный источник");
  const before = (
    await f.db.query("select * from conversation_memory_fragments")
  ).rows;
  const preview = await f.store.snapshot(f.owner, f.thread, "источник", {
    readOnly: true,
  });
  assert.deepEqual(preview, {
    fragments: [],
    complete: false,
    indexComplete: false,
    indexedMessages: 0,
  });
  assert.deepEqual(
    (await f.db.query("select * from conversation_memory_fragments")).rows,
    before,
  );
  await f.db.transaction((tx) =>
    indexConversationMemoryMessage(tx, f.owner, f.thread, id),
  );
  const indexed = (
    await f.db.query("select * from conversation_memory_fragments")
  ).rows;
  const ready = await f.store.snapshot(f.owner, f.thread, "источник", {
    readOnly: true,
  });
  assert.equal(ready.complete, true);
  assert.equal(ready.fragments[0]?.messageId, id);
  assert.deepEqual(
    (await f.db.query("select * from conversation_memory_fragments")).rows,
    indexed,
  );
  const emoji = "😀".repeat(100_000);
  assert.equal(
    (await f.store.snapshot(f.owner, f.thread, emoji, { readOnly: true }))
      .indexComplete,
    true,
  );
  await assert.rejects(
    f.store.snapshot(f.owner, f.thread, "😀".repeat(100_001), {
      readOnly: true,
    }),
  );
});

test(
  "long source memory hashes each original once and verifies only shortlisted quotations",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const base = "Условия жилья: работа, школа, семья и бюджет. ";
    const content = base
      .repeat(Math.ceil(100000 / base.length))
      .slice(0, 100000);
    const ids = (
      await f.db.query<{ id: string }>(
        "insert into messages(thread_id,role,content) select $1,'user',$2 from generate_series(1,40) returning id::text",
        [f.thread, content],
      )
    ).rows;
    for (const { id } of ids)
      await indexConversationMemoryMessage(f.db, f.owner, f.thread, id);
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          "select count(*)::int as n from conversation_memory_fragments",
        )
      ).rows[0]!.n,
      4000,
    );
    const statements: { sql: string; params: unknown[] | undefined }[] = [];
    const traced: Database = {
      ...f.db,
      transaction: (work) =>
        f.db.transaction((tx) =>
          work({
            exec: (sql) => tx.exec(sql),
            query: <T>(sql: string, params?: unknown[]) => {
              if (sql.includes("/* conversation-memory-snapshot */"))
                statements.push({ sql, params });
              return tx.query<T>(sql, params);
            },
          }),
        ),
    };
    const started = performance.now();
    const snapshot = await new ConversationMemory(traced).snapshot(
      f.owner,
      f.thread,
      "работа школа бюджет",
      { readOnly: true },
    );
    const elapsed = performance.now() - started;
    t.diagnostic(
      `40x100k source characters / 4,000 quotations: warm snapshot ${Math.round(elapsed)} ms (PGlite, no provider calls)`,
    );
    assert.ok(
      elapsed < 10000,
      "warm source verification must not repeat full original decoding for thousands of fragments",
    );
    assert.equal(snapshot.indexComplete, true);
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.indexedMessages, 40);
    assert.equal(snapshot.fragments.length, 32);
    for (const part of snapshot.fragments) {
      assert.equal(part.sourceSha256, sha(content));
      assert.equal(part.content, content.slice(part.start, part.end));
    }
    assert.equal(statements.length, 1);
    const { sql, params } = statements[0]!;
    const explained = await f.db.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
      "explain(analyze,buffers,format json) " + sql!,
      params,
    );
    const nodes = planNodes(explained.rows[0]!["QUERY PLAN"][0]!.Plan);
    for (const name of ["sources", "indexed", "verified"]) {
      const node = nodes.find((row) => row["Subplan Name"] === "CTE " + name)!;
      assert.equal(node["Actual Loops"], 1);
      assert.equal(node["Actual Rows"], 40);
    }
    assert.equal(
      nodes.find((row) => row["Subplan Name"] === "CTE candidates")![
        "Actual Rows"
      ],
      32,
    );
  },
);

type PlanNode = { [key: string]: unknown; Plans?: PlanNode[] };
const planNodes = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(planNodes),
];

test("bounded source verification remains honestly partial for old or unsupported history and excludes a corrupted unselected quotation", async (t) => {
  const f = await fixture(t);
  const ids = (
    await f.db.query<{ id: string }>(
      "insert into messages(thread_id,role,content) select $1,'user','История '||i::text from generate_series(1,300)i returning id::text",
      [f.thread],
    )
  ).rows;
  for (const { id } of ids)
    await indexConversationMemoryMessage(f.db, f.owner, f.thread, id);
  const result = await f.store.snapshot(f.owner, f.thread, "история", {
    readOnly: true,
  });
  assert.equal(result.indexComplete, false);
  assert.equal(result.complete, false);
  assert.equal(result.indexedMessages, 264);
  assert.ok(result.fragments.some((part) => part.messageId === ids[0]!.id));
  assert.ok(result.fragments.some((part) => part.messageId === ids[299]!.id));
  const long = await message(f, "а".repeat(100000), { thread: f.sibling });
  await indexConversationMemoryMessage(f.db, f.owner, f.sibling, long);
  // Only the owner/migration fixture can bypass the immutable trigger. A broken
  // middle quotation must invalidate the whole proof even when never selected.
  await f.db.exec(
    "alter table conversation_memory_fragments disable trigger conversation_memory_update_guard",
  );
  await f.db.query(
    "update conversation_memory_fragments set content=repeat('б',1000) where message_id=$1 and ordinal=50",
    [long],
  );
  await f.db.exec(
    "alter table conversation_memory_fragments enable trigger conversation_memory_update_guard",
  );
  const corrupted = await f.store.snapshot(f.owner, f.sibling, "а", {
    readOnly: true,
  });
  assert.equal(corrupted.indexComplete, false);
  assert.equal(corrupted.complete, false);
  assert.deepEqual(corrupted.fragments, []);
  await message(f, "😀".repeat(100001), { thread: f.foreign });
  const unsupported = await f.store.snapshot(f.other, f.foreign, "история");
  assert.equal(unsupported.indexComplete, false);
  assert.deepEqual(unsupported.fragments, []);
});

test("legacy reset tools inventory and retain memory instead of silently deleting source evidence", async (t) => {
  const f = await fixture(t);
  await message(f, "Личная сохранённая цитата");
  await f.store.snapshot(f.owner, f.thread, "цитата");
  for (const store of [
    new AccountReset(f.db),
    new ClosedAccountRestart(f.db),
    new FreshAccountReset(f.db),
  ]) {
    const plan = await store.plan({
      expectedUserCount: 2,
      maintenanceConfirmed: true,
    });
    assert.equal(plan.counts.conversation_memory_fragments, 1);
    assert.ok(
      plan.blockers.some(
        (item) => item.code === "CONVERSATION_MEMORY_REQUIRES_REVIEW",
      ),
    );
    assert.ok(!JSON.stringify(plan).includes("Личная сохранённая цитата"));
  }
});

test("runtime grants append and read exact memory but deny update/delete/truncate and every Worker read", async (t) => {
  const f = await fixture(t);
  await message(f, "Сохранённое условие пользователя");
  await f.db.exec(
    "create role citygo_api;create role citygo_worker;create role citygo_backup;grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  await f.db.exec(grants.replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, ""));
  const asRole = <T>(
    role: string,
    work: (tx: import("./index.js").Sql) => Promise<T>,
  ) =>
    f.db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      return work(tx);
    });
  const runtime: Database = {
    transaction: (work) => asRole("citygo_api", work),
    query: <T>(sql: string, params?: unknown[]) =>
      asRole("citygo_api", (tx) => tx.query<T>(sql, params)),
    exec: (sql) => asRole("citygo_api", (tx) => tx.exec(sql)),
    close: async () => {},
  };
  const memory = await new ConversationMemory(runtime).snapshot(
    f.owner,
    f.thread,
    "условие",
  );
  assert.equal(memory.complete, true);
  const denied = (error: unknown) =>
    (error as { code?: string }).code === "42501";
  for (const sql of [
    "update conversation_memory_fragments set source_sha256=repeat('a',64)",
    "delete from conversation_memory_fragments",
    "truncate conversation_memory_fragments",
  ])
    await assert.rejects(runtime.exec(sql), denied);
  await assert.rejects(
    asRole("citygo_worker", (tx) =>
      tx.query("select * from conversation_memory_fragments"),
    ),
    denied,
  );
  assert.equal(
    (
      await asRole("citygo_backup", (tx) =>
        tx.query("select * from conversation_memory_fragments"),
      )
    ).rows.length,
    1,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select prosecdef from pg_proc where proname='citygo_guard_conversation_memory_fragment'",
      )
    ).rows,
    [{ prosecdef: false }],
  );
});

test("large history pages bound aggregate UTF8 before payload fetch and keep every old row reachable", async (t) => {
  const f = await fixture(t),
    text = "😀".repeat(50_000),
    ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(await message(f, text + i));
  const repo = new Repository(f.db),
    all: string[] = [];
  let before: string | undefined;
  do {
    const page = await repo.conversationMessages(f.owner, f.thread, before);
    assert.ok(page.messages.length <= 100);
    assert.ok(
      page.messages.reduce(
        (sum, row) => sum + Buffer.byteLength(row.content),
        0,
      ) <= CONVERSATION_PAGE_CONTENT_BYTES,
    );
    if (page.nextCursor) assert.equal(page.nextCursor, page.messages[0]!.id);
    all.unshift(...page.messages.map((row) => row.id));
    before = page.nextCursor ?? undefined;
  } while (before);
  assert.deepEqual(all, ids);
  assert.equal((await repo.history(f.db, f.thread)).length, 2);
  assert.equal(
    (await repo.history(f.db, f.thread, CONVERSATION_CONTEXT_CONTENT_BYTES))
      .length,
    12,
  );
  assert.equal(
    (
      await repo.conversationContextSnapshot(
        f.owner,
        f.thread,
        CONVERSATION_CONTEXT_CONTENT_BYTES,
      )
    ).messages.length,
    12,
  );
  await assert.rejects(
    repo.history(f.db, f.thread, (35 * 1024 * 1024) as never),
  );
  const detail = await repo.conversation(f.owner, f.thread);
  assert.equal(detail.thread.messagesNextCursor, ids.at(-2));
  assert.equal(detail.thread.messages.length, 2);
  const legacy = await message(f, "\u0001".repeat(800_000));
  const page = await repo.conversationMessages(f.owner, f.thread);
  assert.deepEqual(
    page.messages.map((row) => row.id),
    [legacy],
  );
  assert.equal(page.nextCursor, legacy);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 8 * 1024 * 1024);
  const older = await repo.conversationMessages(
    f.owner,
    f.thread,
    page.nextCursor!,
  );
  assert.deepEqual(
    older.messages.map((row) => row.id),
    ids.slice(-2),
  );
});

test("only the explicit internal context reader admits 256 rows; HTTP history and legacy context remain capped at 100", async (t) => {
  const f = await fixture(t),
    repo = new Repository(f.db);
  await f.db.query(
    "insert into messages(thread_id,role,content)select $1,case when i%2=0 then 'assistant' else 'user' end,'Synthetic round '||i::text from generate_series(1,300)i",
    [f.thread],
  );
  assert.equal((await repo.history(f.db, f.thread)).length, 100);
  const internal = await repo.history(
    f.db,
    f.thread,
    CONVERSATION_CONTEXT_CONTENT_BYTES,
  );
  assert.equal(internal.length, 256);
  assert.equal(internal[0]!.content, "Synthetic round 45");
  assert.equal(internal.at(-1)!.content, "Synthetic round 300");
  assert.equal(
    (await repo.conversationContextSnapshot(f.owner, f.thread)).messages.length,
    100,
  );
  assert.equal(
    (
      await repo.conversationContextSnapshot(
        f.owner,
        f.thread,
        CONVERSATION_CONTEXT_CONTENT_BYTES,
      )
    ).messages.length,
    256,
  );
  assert.equal(
    (await repo.conversationMessages(f.owner, f.thread)).messages.length,
    100,
  );
  assert.equal(
    (await repo.conversation(f.owner, f.thread)).thread.messages.length,
    100,
  );
});

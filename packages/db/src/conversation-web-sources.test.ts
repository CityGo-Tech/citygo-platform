import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  conversationMessagesResponseSchema,
  validateWebSourcesForAnswer,
  type ModelGeneration,
  type WebSources,
} from "@citygo/contracts";
import {
  connectDatabase,
  ensureConversation,
  migrate,
  MessageFavorites,
  Repository,
  DomainError,
  CONVERSATION_PAGE_CONTENT_BYTES,
  CONVERSATION_CONTEXT_CONTENT_BYTES,
  type Database,
} from "./index.js";

const model = "openai/gpt-6.1-sol";
const answer = "Сравните условия по официальному источнику. 🏠";
const sources: WebSources = {
  version: "routerai_native_v1",
  citations: [
    { url: "https://www.mos.ru/news/", title: "Официальные новости Москвы" },
  ],
};
const generation = (webSources = sources): ModelGeneration => ({
  provider: "routerai",
  requestedModel: model,
  model,
  usage: { inputTokens: 23, outputTokens: 7 },
  webSources,
});

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const users = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject)values($1),($2)returning id::text",
      [randomUUID(), randomUUID()],
    )
  ).rows;
  const owner = users[0]!.id,
    other = users[1]!.id;
  const thread = (await ensureConversation(db, owner, "housing")).id;
  const foreign = (await ensureConversation(db, other, "housing")).id;
  return {
    db,
    owner,
    other,
    thread,
    foreign,
    repo: new Repository(db),
    favorites: new MessageFavorites(db),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function running(f: Fixture, thread = f.thread) {
  const requestId = randomUUID(),
    lease = randomUUID();
  await f.db.transaction(async (tx) => {
    await tx.query(
      "update agent_threads set lease_token=$2,busy_until=clock_timestamp()+interval'1 minute' where id=$1",
      [thread, lease],
    );
    await tx.query(
      "insert into chat_requests(thread_id,request_id,status)values($1,$2,'running')",
      [thread, requestId],
    );
  });
  return { thread, requestId, lease };
}
async function finish(f: Fixture, content = answer, webSources = sources) {
  const request = await running(f);
  const id = await f.repo.finishChat(
    request.thread,
    request.requestId,
    request.lease,
    "housing",
    content,
    true,
    true,
    generation(webSources),
  );
  return { ...request, id };
}
const domainStatus = (status: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === status;
async function state(db: Database) {
  return (
    await db.query(`select jsonb_build_object(
    'messages',(select coalesce(jsonb_agg(to_jsonb(m)order by id),'[]'::jsonb)from messages m),
    'requests',(select coalesce(jsonb_agg(to_jsonb(r)order by thread_id,request_id),'[]'::jsonb)from chat_requests r),
    'threads',(select coalesce(jsonb_agg(to_jsonb(t)order by id),'[]'::jsonb)from agent_threads t),
    'entries',(select coalesce(jsonb_agg(to_jsonb(e)order by id),'[]'::jsonb)from ai_credit_entries e),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a)order by to_jsonb(a)::text),'[]'::jsonb)from ai_model_attempts a)
  )as value`)
  ).rows[0];
}

test("finishChat stores checked provider sources atomically and preserves them through owned history, exact context and bookmark changes", async (t) => {
  const f = await fixture(t),
    saved = await finish(f);
  const expected = validateWebSourcesForAnswer(sources, answer);
  const persisted = (
    await f.db.query<{
      role: string;
      content: string;
      metadata: Record<string, unknown>;
    }>("select role,content,metadata from messages where id=$1", [saved.id])
  ).rows[0]!;
  assert.equal(persisted.role, "assistant");
  assert.equal(persisted.content, answer);
  assert.deepEqual(persisted.metadata, {
    agentKey: "housing",
    status: "complete",
    source: "model",
    generation: generation(expected),
  });
  assert.equal(
    (
      await f.db.query<{ status: string }>(
        "select status from chat_requests where thread_id=$1 and request_id=$2",
        [f.thread, saved.requestId],
      )
    ).rows[0]!.status,
    "complete",
  );
  assert.equal(
    (
      await f.db.query<{ lease_token: string | null }>(
        "select lease_token from agent_threads where id=$1",
        [f.thread],
      )
    ).rows[0]!.lease_token,
    null,
  );
  const readers = [
    (await f.repo.conversation(f.owner, f.thread)).thread.messages,
    await f.repo.history(f.db, f.thread),
    (await f.repo.conversationMessages(f.owner, f.thread)).messages,
    (await f.repo.conversationMessageContext(f.owner, f.thread, saved.id))
      .messages,
    (await f.repo.conversationContextSnapshot(f.owner, f.thread)).messages,
  ];
  for (const messages of readers) {
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.id, saved.id);
    assert.deepEqual(messages[0]!.generation?.webSources, expected);
  }
  conversationMessagesResponseSchema.parse(
    await f.repo.conversationMessages(f.owner, f.thread),
  );
  for (const savedBookmark of [true, true, false]) {
    await f.favorites.set(f.owner, saved.id, savedBookmark);
    const page = await f.repo.conversationMessageContext(
      f.owner,
      f.thread,
      saved.id,
    );
    assert.equal(page.messages[0]!.favorite, savedBookmark);
    assert.deepEqual(page.messages[0]!.generation?.webSources, expected);
    assert.equal(
      (await f.favorites.list(f.owner)).messages.length,
      savedBookmark ? 1 : 0,
    );
  }
  const beforeReplay = await state(f.db);
  await assert.rejects(
    f.repo.finishChat(
      f.thread,
      saved.requestId,
      saved.lease,
      "housing",
      answer,
      true,
      true,
      generation(),
    ),
    domainStatus(409),
  );
  assert.deepEqual(await state(f.db), beforeReplay);
  assert.equal(
    (await f.db.query("select id from ai_credit_entries")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_model_attempts")).rows.length,
    0,
  );
});

test("source-bearing answers remain private across users, conversation cursors and bookmark writes", async (t) => {
  const f = await fixture(t),
    saved = await finish(f),
    before = await state(f.db);
  for (const read of [
    () => f.repo.conversation(f.other, f.thread),
    () => f.repo.conversationMessages(f.other, f.thread),
    () => f.repo.conversationMessages(f.other, f.thread, saved.id),
    () => f.repo.conversationMessageContext(f.other, f.thread, saved.id),
    () => f.repo.conversationContextSnapshot(f.other, f.thread),
    () => f.repo.conversationMessageContext(f.owner, f.foreign, saved.id),
    () => f.favorites.set(f.other, saved.id, true),
  ])
    await assert.rejects(read(), domainStatus(404));
  assert.deepEqual((await f.favorites.list(f.other)).messages, []);
  assert.deepEqual(await state(f.db), before);
});

test("invalid source completion state, model identity or unsafe citation is rejected before opening a database transaction", async () => {
  let calls = 0;
  const unexpected = () => {
    calls++;
    throw new Error("Unexpected database call");
  };
  const db: Database = {
    query: unexpected,
    exec: unexpected,
    transaction: unexpected,
    close: async () => {},
  };
  const repo = new Repository(db);
  const invalid: {
    complete?: boolean;
    modelResponse?: boolean;
    generation?: unknown;
    text?: string;
  }[] = [
    { complete: false },
    { modelResponse: false },
    { text: "" },
    { text: "x".repeat(128001) },
    { generation: { ...generation(), provider: "gigachat" } },
    { generation: { ...generation(), requestedModel: "other/model" } },
    { generation: { ...generation(), model: "gpt-6.1-sol" } },
    { generation: { ...generation(), model: undefined } },
    ...[
      "http://www.mos.ru/",
      "javascript:alert(1)",
      "https://127.0.0.1/",
      "https://user:secret@www.mos.ru/",
    ].map((url) => ({
      generation: generation({
        ...sources,
        citations: [{ url, title: "Synthetic source" }],
      }),
    })),
    {
      generation: {
        ...generation(),
        webSources: { version: "other", citations: sources.citations },
      },
    },
    {
      generation: {
        ...generation(),
        webSources: { ...sources, citations: [] },
      },
    },
  ];
  for (const value of invalid) {
    await assert.rejects(
      repo.finishChat(
        "1",
        randomUUID(),
        randomUUID(),
        "housing",
        value.text ?? answer,
        value.complete ?? true,
        value.modelResponse ?? true,
        (value.generation ?? generation()) as ModelGeneration,
      ),
      domainStatus(400),
    );
    assert.equal(calls, 0);
  }
  for (const complete of [true, false]) {
    await assert.rejects(
      repo.finishGigaChat({
        userId: "1",
        threadId: "1",
        requestId: randomUUID(),
        lease: randomUUID(),
        agent: "housing",
        content: answer,
        complete,
        generation: {
          ...generation(),
          provider: "gigachat",
          requestedModel: "GigaChat-3-Ultra",
          model: "GigaChat-3-Ultra",
        },
        holdId: randomUUID(),
      }),
      domainStatus(400),
    );
    assert.equal(calls, 0);
  }
});

test("corrupt stored source metadata fails closed on owned reads without exposing its URL", async (t) => {
  const f = await fixture(t),
    saved = await finish(f);
  const patches = [
    { role: "user" },
    {
      metadata: {
        agentKey: "housing",
        status: "interrupted",
        generation: generation(),
      },
    },
    {
      metadata: {
        agentKey: "housing",
        status: "complete",
        generation: { ...generation(), provider: "gigachat" },
      },
    },
    {
      metadata: {
        agentKey: "housing",
        status: "complete",
        generation: generation({
          ...sources,
          citations: [
            { url: "https://127.0.0.1/private", title: "Corrupt source" },
          ],
        }),
      },
    },
  ];
  for (const patch of patches) {
    await f.db.query(
      "update messages set role=$2,metadata=$3::jsonb where id=$1",
      [
        saved.id,
        patch.role ?? "assistant",
        JSON.stringify(
          patch.metadata ?? {
            agentKey: "housing",
            status: "complete",
            generation: generation(),
          },
        ),
      ],
    );
    await assert.rejects(
      f.repo.conversationMessages(f.owner, f.thread),
      (error: unknown) => {
        assert.equal(error instanceof DomainError && error.statusCode, 503);
        assert.equal(String(error).includes("127.0.0.1"), false);
        return true;
      },
    );
  }
});

test("a failed finish transaction rolls back its source-bearing answer and keeps the running request and lease", async (t) => {
  const f = await fixture(t),
    request = await running(f),
    before = await state(f.db);
  const failing: Database = {
    ...f.db,
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          exec: (sql) => tx.exec(sql),
          query: <T>(sql: string, params?: unknown[]) => {
            if (sql.startsWith("update chat_requests set status="))
              throw new Error(
                "Synthetic transaction interruption after message INSERT",
              );
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new Repository(failing).finishChat(
      f.thread,
      request.requestId,
      request.lease,
      "housing",
      answer,
      true,
      true,
      generation(),
    ),
    /Synthetic transaction interruption/,
  );
  assert.deepEqual(await state(f.db), before);
  assert.equal(
    (await f.repo.conversationMessages(f.owner, f.thread)).messages.length,
    0,
  );
});

test("history budget counts source metadata before payload fetch and keeps both large answers reachable by exact cursor", async (t) => {
  const f = await fixture(t),
    content = "я".repeat(128000);
  const largeSources: WebSources = {
    version: "routerai_native_v1",
    citations: Array.from({ length: 5 }, (_, n) => ({
      url: "https://www.mos.ru/search?q=" + "x".repeat(1750) + n,
      title: `Источник ${n}: ` + "я".repeat(90),
    })),
  };
  const metadataBytes = Buffer.byteLength(JSON.stringify(largeSources), "utf8");
  assert.ok(metadataBytes >= 9000 && metadataBytes <= 12000);
  assert.ok(metadataBytes < 16 * 1024);
  const first = await finish(f, content, largeSources),
    second = await finish(f, content, largeSources);
  const totals = (
    await f.db.query<{ content: number; with_generation: number }>(
      `select sum(octet_length(content))::int as content,
      sum(octet_length(content)+octet_length((metadata->'generation')::text))::int as with_generation
      from messages where thread_id=$1`,
      [f.thread],
    )
  ).rows[0]!;
  assert.equal(totals.content, 512000);
  assert.ok(totals.content < CONVERSATION_PAGE_CONTENT_BYTES);
  assert.ok(totals.with_generation > CONVERSATION_PAGE_CONTENT_BYTES);
  const latest = await f.repo.conversationMessages(f.owner, f.thread);
  conversationMessagesResponseSchema.parse(latest);
  assert.deepEqual(
    latest.messages.map((message) => message.id),
    [second.id],
  );
  assert.equal(latest.nextCursor, second.id);
  assert.deepEqual(latest.messages[0]!.generation?.webSources, largeSources);
  const older = await f.repo.conversationMessages(
    f.owner,
    f.thread,
    latest.nextCursor!,
  );
  conversationMessagesResponseSchema.parse(older);
  assert.deepEqual(
    older.messages.map((message) => message.id),
    [first.id],
  );
  assert.equal(older.nextCursor, null);
  assert.deepEqual(older.messages[0]!.generation?.webSources, largeSources);
  const detail = await f.repo.conversation(f.owner, f.thread);
  assert.deepEqual(
    detail.thread.messages.map((message) => message.id),
    [second.id],
  );
  assert.equal(detail.thread.messagesNextCursor, second.id);
  const exact = await f.repo.conversationMessageContext(
    f.owner,
    f.thread,
    first.id,
  );
  assert.deepEqual(
    exact.messages.map((message) => message.id),
    [first.id],
  );
  assert.equal(exact.nextCursor, null);
  const internal = await f.repo.conversationContextSnapshot(
    f.owner,
    f.thread,
    CONVERSATION_CONTEXT_CONTENT_BYTES,
  );
  assert.deepEqual(
    internal.messages.map((message) => message.id),
    [first.id, second.id],
  );
});

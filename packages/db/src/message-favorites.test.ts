import assert from "node:assert/strict";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  MessageFavorites,
  Repository,
  DomainError,
} from "./index.js";

test("private bookmarks preserve message metadata, are replay-safe and disappear with their source", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    store = new MessageFavorites(db);
  const owner = await repo.register("owner@example.test", "synthetic"),
    other = await repo.register("other@example.test", "synthetic");
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const message = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) values($1,'assistant','Saved synthetic answer',$2) returning id::text",
      [
        thread,
        JSON.stringify({
          agentKey: "support",
          status: "interrupted",
          generation: { model: "synthetic" },
          source: "model",
        }),
      ],
    )
  ).rows[0]!.id;
  for (const saved of [true, true])
    assert.deepEqual(await store.set(owner, message, saved), {
      messageId: message,
      saved,
    });
  assert.deepEqual(
    (await store.list(owner)).messages.map((item) => [item.id, item.status]),
    [[message, "interrupted"]],
  );
  assert.deepEqual((await store.list(other)).messages, []);
  for (const id of [message, "999999"])
    await assert.rejects(
      store.set(other, id, true),
      (error) => error instanceof DomainError && error.statusCode === 404,
    );
  assert.equal((await repo.history(db, thread))[0]!.favorite, true);
  await store.set(owner, message, false);
  assert.equal((await store.list(owner)).messages.length, 0);
  const row = (
    await db.query<{ content: string; metadata: Record<string, unknown> }>(
      "select content,metadata from messages where id=$1",
      [message],
    )
  ).rows[0]!;
  assert.equal(row.content, "Saved synthetic answer");
  assert.deepEqual(row.metadata, {
    agentKey: "support",
    status: "interrupted",
    generation: { model: "synthetic" },
    source: "model",
    citygoFavorite: false,
  });
  await store.set(owner, message, true);
  await db.query("delete from messages where id=$1", [message]);
  assert.equal((await store.list(owner)).messages.length, 0);
  assert.equal(
    (await db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select 1 from ai_model_attempts")).rows.length,
    0,
  );
});

test("favorites paginate by exact message ID, include closed threads, exclude tool/system messages", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "page@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status) values($1,'support','closed') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content,metadata) select $1,'user','synthetic-'||n,'{\"citygoFavorite\":true}'::jsonb from generate_series(1,24) n",
    [thread],
  );
  const store = new MessageFavorites(db);
  const first = await store.list(owner);
  assert.equal(first.messages.length, 20);
  assert.equal(first.nextBefore, first.messages.at(-1)!.id);
  const second = await store.list(owner, first.nextBefore!);
  assert.equal(second.messages.length, 4);
  assert.equal(second.nextBefore, null);
  assert.equal(
    new Set([...first.messages, ...second.messages].map((m) => m.id)).size,
    24,
  );
  const tool = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content,metadata) values($1,'tool','not visible','{\"citygoFavorite\":true}') returning id::text",
      [thread],
    )
  ).rows[0]!.id;
  await assert.rejects(
    store.set(owner, tool, true),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  assert.equal(
    (await store.list(owner)).messages.some((m) => m.id === tool),
    false,
  );
});

test("favorites keep numeric order across decimal boundaries and bigint IDs", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "bigint@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const ids = ["9", "10", "99", "100", "9007199254740992", "9007199254740993"];
  for (const id of ids)
    await db.query(
      "insert into messages(id,thread_id,role,content,metadata) overriding system value values($1,$2,'user','synthetic','{\"citygoFavorite\":true}')",
      [id, thread],
    );
  const store = new MessageFavorites(db);
  assert.deepEqual(
    (await store.list(owner)).messages.map((m) => m.id),
    [...ids].reverse(),
  );
  assert.deepEqual(
    (await store.list(owner, "9007199254740993")).messages.map((m) => m.id),
    ids.slice(0, -1).reverse(),
  );
  assert.deepEqual(
    (await store.list(owner, "100")).messages.map((m) => m.id),
    ["99", "10", "9"],
  );
});

test("favorite byte pagination preserves full escaped Unicode text without skipping messages", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "bytes@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const content = "\u0001".repeat(350000) + "Москва 🏙️";
  const ids = [
    "9007199254741001",
    "9007199254741002",
    "9007199254741003",
    "9007199254741004",
    "9007199254741005",
  ];
  for (const id of ids)
    await db.query(
      "insert into messages(id,thread_id,role,content,metadata) overriding system value values($1,$2,'user',$3,'{\"citygoFavorite\":true}')",
      [id, thread, content],
    );
  const store = new MessageFavorites(db);
  const first = await store.list(owner);
  const second = await store.list(owner, first.nextBefore!);
  const third = await store.list(owner, second.nextBefore!);
  assert.deepEqual(
    [first.messages.length, second.messages.length, third.messages.length],
    [2, 2, 1],
  );
  assert.equal(third.nextBefore, null);
  assert.deepEqual(
    [first, second, third].flatMap((page) => page.messages.map((m) => m.id)),
    [...ids].reverse(),
  );
  for (const page of [first, second, third]) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 6 * 1024 * 1024);
    assert.ok(page.messages.every((message) => message.content === content));
  }
});

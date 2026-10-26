import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  migrate,
  PersonalMemory,
  Repository,
  DomainError,
  type Database,
} from "./index.js";

const errorStatus = (status: number, revision?: number) => (error: unknown) =>
  error instanceof DomainError &&
  error.statusCode === status &&
  (revision === undefined ||
    (error.code === "REVISION_CONFLICT" && error.currentVersion === revision));
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    owner = await repo.register("memory-owner@example.test", "synthetic"),
    other = await repo.register("memory-other@example.test", "synthetic");
  async function source(
    user = owner,
    role = "assistant",
    status: string | null = "complete",
  ) {
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,conversation_agent_key,status) values($1,'support','support','closed') returning id::text",
        [user],
      )
    ).rows[0]!.id;
    const id = (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content,metadata) values($1,$2,'Synthetic source',$3) returning id::text",
        [
          thread,
          role,
          JSON.stringify(status === null ? {} : { status, marker: "preserve" }),
        ],
      )
    ).rows[0]!.id;
    return { id, thread };
  }
  const message = await source();
  const input = () => ({
    operationId: randomUUID(),
    sourceMessageId: message.id,
    label: "  Переезжаю  ",
    value: "  Из Казани в Москву  ",
    confirmed: true as const,
  });
  return {
    db,
    owner,
    other,
    message,
    source,
    input,
    store: new PersonalMemory(db),
  };
}
const count = async (db: Database, table: string) =>
  (
    await db.query<{ count: number }>(
      `select count(*)::integer as count from ${table}`,
    )
  ).rows[0]!.count;

test("private confirmed memory works without a profile, retains provenance and never changes messages, quests or money", async (t) => {
  const f = await fixture(t),
    created = await f.store.create(f.owner, f.input());
  assert.equal(created.userId, f.owner);
  assert.equal(created.item.label, "Переезжаю");
  assert.equal(created.item.value, "Из Казани в Москву");
  assert.equal(created.item.revision, 1);
  assert.deepEqual(created.item.source, {
    messageId: f.message.id,
    threadId: f.message.thread,
    role: "assistant",
  });
  assert.equal((await f.store.list(f.owner)).items.length, 1);
  assert.deepEqual((await f.store.list(f.other)).items, []);
  for (const source of [
    await f.source(f.other),
    await f.source(f.owner, "tool"),
    await f.source(f.owner, "system"),
    await f.source(f.owner, "assistant", "interrupted"),
    await f.source(f.owner, "assistant", "running"),
    await f.source(f.owner, "user", "interrupted"),
    await f.source(f.owner, "assistant", "unknown"),
  ])
    await assert.rejects(
      f.store.create(f.owner, { ...f.input(), sourceMessageId: source.id }),
      errorStatus(404),
    );
  await assert.rejects(
    f.store.update(f.other, created.item.id, {
      expectedRevision: 1,
      label: "Stolen",
      value: "No",
      confirmed: true,
    }),
    errorStatus(404),
  );
  await assert.rejects(
    f.store.remove(f.other, created.item.id, 1),
    errorStatus(404),
  );
  assert.deepEqual(
    (
      await f.db.query("select content,metadata from messages where id=$1", [
        f.message.id,
      ])
    ).rows,
    [
      {
        content: "Synthetic source",
        metadata: { status: "complete", marker: "preserve" },
      },
    ],
  );
  for (const table of [
    "relocation_profiles",
    "questionnaire_answers",
    "relocation_plans",
    "user_quests",
    "xp_events",
    "ai_credit_entries",
    "ai_model_attempts",
    "personal_plan_items",
  ])
    assert.equal(await count(f.db, table), 0, table);
  const user = await f.source(f.owner, "user", null);
  assert.equal(
    (await f.store.create(f.owner, { ...f.input(), sourceMessageId: user.id }))
      .item.source.role,
    "user",
  );
});

test("stable operation binds normalized input and replays current edits, but never overwrites or resurrects deleted facts", async (t) => {
  const f = await fixture(t),
    input = f.input(),
    first = await f.store.create(f.owner, input);
  assert.deepEqual(
    await f.store.create(f.owner, {
      ...input,
      label: input.label.trim(),
      value: input.value.trim(),
    }),
    first,
  );
  const edited = await f.store.update(f.owner, first.item.id, {
    expectedRevision: 1,
    label: "Состав переезда",
    value: "Переезжаю с партнёром",
    confirmed: true,
  });
  assert.equal(edited.item.revision, 2);
  assert.deepEqual(await f.store.create(f.owner, input), edited);
  for (const changed of [
    { label: "Different" },
    { value: "Different" },
    { sourceMessageId: (await f.source()).id },
  ])
    await assert.rejects(
      f.store.create(f.owner, { ...input, ...changed }),
      errorStatus(409),
    );
  await f.store.remove(f.owner, first.item.id, 2);
  await assert.rejects(f.store.create(f.owner, input), errorStatus(409));
  assert.equal(await count(f.db, "personal_memory_items"), 1);
  assert.deepEqual(
    (
      await f.db.query(
        "select label,value,revision::text,deleted_at is not null as deleted from personal_memory_items",
      )
    ).rows,
    [{ label: "", value: "", revision: "3", deleted: true }],
  );
  assert.deepEqual(
    (
      await f.db.query("select content from messages where id=$1", [
        f.message.id,
      ])
    ).rows,
    [{ content: "Synthetic source" }],
  );
});

test("CAS preserves newer corrections, stale delete conflicts and repeated removal is safe without retaining deleted text", async (t) => {
  const f = await fixture(t),
    created = await f.store.create(f.owner, f.input());
  const update = {
    expectedRevision: 1,
    label: "Дата",
    value: "Пока не знаю",
    confirmed: true as const,
  };
  const next = await f.store.update(f.owner, created.item.id, update);
  assert.equal(next.item.revision, 2);
  await assert.rejects(
    f.store.update(f.owner, created.item.id, { ...update, value: "stale" }),
    errorStatus(409, 2),
  );
  await assert.rejects(
    f.store.remove(f.owner, created.item.id, 1),
    errorStatus(409, 2),
  );
  const removed = await f.store.remove(f.owner, created.item.id, 2);
  assert.deepEqual(await f.store.remove(f.owner, created.item.id, 1), removed);
  assert.equal((await f.store.list(f.owner)).items.length, 0);
  await assert.rejects(
    f.store.update(f.owner, created.item.id, {
      ...update,
      expectedRevision: 3,
    }),
    errorStatus(404),
  );
});

test("twenty active facts preserve bigint order; capacity permits replay, frees one place after erasure and cannot be bypassed by direct INSERT", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "select setval('personal_memory_items_id_seq',9007199254740992,false)",
  );
  const input = f.input(),
    first = await f.store.create(f.owner, input);
  assert.equal(first.item.id, "9007199254740992");
  for (let index = 1; index < 20; index++)
    await f.store.create(f.owner, { ...f.input(), label: `Сведение ${index}` });
  const rows = (await f.store.list(f.owner)).items;
  assert.equal(rows.length, 20);
  assert.equal(rows.at(-1)!.id, first.item.id);
  assert.equal(BigInt(rows[0]!.id) > BigInt(rows[1]!.id), true);
  assert.equal((await f.store.create(f.owner, input)).item.id, first.item.id);
  await assert.rejects(f.store.create(f.owner, f.input()), errorStatus(409));
  await assert.rejects(
    f.db.query(
      "insert into personal_memory_items(user_id,source_message_id,operation_id,create_request_hash,label,value) values($1,$2,$3,repeat('a',64),'Bypass','No')",
      [f.owner, f.message.id, randomUUID()],
    ),
    { code: "23514" },
  );
  await f.store.remove(f.owner, first.item.id, 1);
  await f.store.create(f.owner, f.input());
  assert.equal((await f.store.list(f.owner)).items.length, 20);
  await f.db.query("delete from messages where id=$1", [f.message.id]);
  assert.equal(await count(f.db, "personal_memory_items"), 0);
});

test("blocked and temporary-password owners cannot write/replay; corrupt stored DTOs fail closed instead of being silently repaired", async (t) => {
  const f = await fixture(t),
    input = f.input(),
    created = await f.store.create(f.owner, input);
  for (const [status, mustChange, expected] of [
    ["blocked", false, 401],
    ["active", true, 403],
  ] as const) {
    await f.db.query(
      "update users set status=$2,must_change_password=$3 where id=$1",
      [f.owner, status, mustChange],
    );
    assert.equal((await f.store.list(f.owner)).items.length, 0);
    await assert.rejects(f.store.create(f.owner, input), errorStatus(expected));
    await assert.rejects(
      f.store.update(f.owner, created.item.id, {
        expectedRevision: 1,
        label: "No",
        value: "No",
        confirmed: true,
      }),
      errorStatus(expected),
    );
    await assert.rejects(
      f.store.remove(f.owner, created.item.id, 1),
      errorStatus(expected),
    );
  }
  await f.db.query(
    "update users set status='active',must_change_password=false where id=$1",
    [f.owner],
  );
  await f.db.query(
    "update personal_memory_items set label=chr(9),revision=revision+1,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where id=$1",
    [created.item.id],
  );
  const before = (await f.db.query("select * from personal_memory_items")).rows;
  await assert.rejects(f.store.list(f.owner), errorStatus(500));
  await assert.rejects(f.store.create(f.owner, input), errorStatus(500));
  await assert.rejects(
    f.store.update(f.owner, created.item.id, {
      expectedRevision: 2,
      label: "Repair",
      value: "No",
      confirmed: true,
    }),
    errorStatus(500),
  );
  await assert.rejects(
    f.store.remove(f.owner, created.item.id, 2),
    errorStatus(500),
  );
  assert.deepEqual(
    (await f.db.query("select * from personal_memory_items")).rows,
    before,
  );
});

test("database guards reject foreign/incomplete sources, identity rewrites, resurrection and tombstones that retain content", async (t) => {
  const f = await fixture(t),
    first = await f.store.create(f.owner, f.input());
  for (const source of [
    await f.source(f.other),
    await f.source(f.owner, "assistant", "interrupted"),
  ])
    await assert.rejects(
      f.db.query(
        "insert into personal_memory_items(user_id,source_message_id,operation_id,create_request_hash,label,value) values($1,$2,$3,repeat('a',64),'No','No')",
        [f.owner, source.id, randomUUID()],
      ),
      { code: "23514" },
    );
  for (const clause of [
    "user_id=" + f.other,
    "source_message_id=" + (await f.source()).id,
    "operation_id='" + randomUUID() + "'",
    "create_request_hash=repeat('b',64)",
    "created_at=clock_timestamp()",
    "revision=revision+2",
  ])
    await assert.rejects(
      f.db.query(
        `update personal_memory_items set ${clause},updated_at=clock_timestamp() where id=$1`,
        [first.item.id],
      ),
    );
  await assert.rejects(
    f.db.query(
      "update personal_memory_items set deleted_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 where id=$1",
      [first.item.id],
    ),
  );
  await f.store.remove(f.owner, first.item.id, 1);
  await assert.rejects(
    f.db.query(
      "update personal_memory_items set label='Revive',value='No',deleted_at=null,revision=revision+1,updated_at=clock_timestamp() where id=$1",
      [first.item.id],
    ),
  );
  await f.db.query("delete from users where id=$1", [f.owner]);
  assert.equal(await count(f.db, "personal_memory_items"), 0);
});

test("migration31 is additive over populated schema30 and starts with empty confirmed memory", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0031")
    .sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  const user = await new Repository(db).register(
    "upgrade-memory@example.test",
    "synthetic",
  );
  const before = (await db.query("select * from users order by id")).rows;
  const sequences = (
    await db.query(
      "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
    )
  ).rows;
  await db.exec(
    await readFile(new URL("0031_personal_memory.sql", directory), "utf8"),
  );
  assert.deepEqual(
    (await db.query("select * from users order by id")).rows,
    before,
  );
  assert.deepEqual(
    (
      await db.query<{ sequencename: string; last_value: string | null }>(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows.filter((r) => r.sequencename !== "personal_memory_items_id_seq"),
    sequences,
  );
  assert.equal(await count(db, "personal_memory_items"), 0);
  assert.equal((await new PersonalMemory(db).list(user)).items.length, 0);
});

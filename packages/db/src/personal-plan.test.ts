import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  PersonalPlan,
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
  const repo = new Repository(db);
  const owner = await repo.register("plan-owner@example.test", "synthetic");
  const other = await repo.register("plan-other@example.test", "synthetic");
  async function source(user = owner, role = "assistant") {
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
          JSON.stringify({ status: "complete", marker: "preserve" }),
        ],
      )
    ).rows[0]!.id;
    return { id, thread };
  }
  const message = await source();
  const input = () => ({
    operationId: randomUUID(),
    sourceMessageId: message.id,
    title: "  Найти район  ",
    details: "  Сравнить время в пути  ",
  });
  return {
    db,
    owner,
    other,
    message,
    source,
    input,
    store: new PersonalPlan(db),
  };
}
async function count(db: Database, table: string) {
  // All names are fixed test constants, never user input.
  return (
    await db.query<{ count: number }>(
      `select count(*)::integer as count from ${table}`,
    )
  ).rows[0]!.count;
}

test("private plan works without a profile, retains source ownership and never changes chat, quests or money", async (t) => {
  const f = await fixture(t);
  const created = await f.store.create(f.owner, f.input());
  assert.equal(created.userId, f.owner);
  assert.equal(created.item.title, "Найти район");
  assert.equal(created.item.details, "Сравнить время в пути");
  assert.deepEqual(created.item.source, {
    messageId: f.message.id,
    threadId: f.message.thread,
    role: "assistant",
  });
  assert.equal(created.item.revision, 1);
  assert.equal(created.item.status, "pending");
  assert.equal((await f.store.list(f.owner)).items.length, 1);
  assert.deepEqual((await f.store.list(f.other)).items, []);
  for (const source of [
    await f.source(f.other),
    await f.source(f.owner, "tool"),
    await f.source(f.owner, "system"),
  ])
    await assert.rejects(
      f.store.create(f.owner, { ...f.input(), sourceMessageId: source.id }),
      errorStatus(404),
    );
  await assert.rejects(
    f.store.update(f.other, created.item.id, {
      expectedRevision: 1,
      title: "Stolen",
      details: "",
      status: "completed",
    }),
    errorStatus(404),
  );
  await assert.rejects(
    f.store.remove(f.other, created.item.id, 1),
    errorStatus(404),
  );
  const message = (
    await f.db.query<{ content: string; metadata: unknown }>(
      "select content,metadata from messages where id=$1",
      [f.message.id],
    )
  ).rows[0]!;
  assert.deepEqual(message, {
    content: "Synthetic source",
    metadata: { status: "complete", marker: "preserve" },
  });
  for (const table of [
    "relocation_profiles",
    "questionnaire_answers",
    "relocation_plans",
    "user_quests",
    "xp_events",
    "ai_credit_entries",
    "ai_model_attempts",
  ])
    assert.equal(await count(f.db, table), 0, table);
  const userSource = await f.source(f.owner, "user");
  assert.equal(
    (
      await f.store.create(f.owner, {
        ...f.input(),
        sourceMessageId: userSource.id,
      })
    ).item.source.role,
    "user",
  );
});

test("a stable operation binds the original normalized request and replays current state without overwriting edits or resurrecting removals", async (t) => {
  const f = await fixture(t),
    input = f.input();
  const first = await f.store.create(f.owner, input);
  assert.deepEqual(
    await f.store.create(f.owner, {
      ...input,
      title: input.title.trim(),
      details: input.details.trim(),
    }),
    first,
  );
  const edited = await f.store.update(f.owner, first.item.id, {
    expectedRevision: 1,
    title: "Мой следующий шаг",
    details: "Моя правка",
    status: "completed",
  });
  assert.equal(edited.item.revision, 2);
  assert.deepEqual(await f.store.create(f.owner, input), edited);
  await assert.rejects(
    f.store.create(f.owner, { ...input, title: "Different" }),
    errorStatus(409),
  );
  await assert.rejects(
    f.store.create(f.owner, {
      ...input,
      sourceMessageId: (await f.source()).id,
    }),
    errorStatus(409),
  );
  await f.store.remove(f.owner, first.item.id, 2);
  await assert.rejects(f.store.create(f.owner, input), errorStatus(409));
  assert.equal(await count(f.db, "personal_plan_items"), 1);
});

test("CAS preserves another edit, stale remove conflicts, completed steps reopen and repeated removal is idempotent", async (t) => {
  const f = await fixture(t),
    created = await f.store.create(f.owner, f.input());
  const update = {
    expectedRevision: 1,
    title: "Подтверждённый выбор",
    details: "",
    status: "completed" as const,
  };
  const next = await f.store.update(f.owner, created.item.id, update);
  await assert.rejects(
    f.store.update(f.owner, created.item.id, { ...update, title: "Stale" }),
    errorStatus(409, 2),
  );
  await assert.rejects(
    f.store.remove(f.owner, created.item.id, 1),
    errorStatus(409, 2),
  );
  const reopened = await f.store.update(f.owner, created.item.id, {
    ...update,
    expectedRevision: 2,
    status: "pending",
  });
  assert.equal(reopened.item.revision, 3);
  assert.equal(reopened.item.status, "pending");
  const removed = await f.store.remove(f.owner, created.item.id, 3);
  assert.deepEqual(await f.store.remove(f.owner, created.item.id, 1), removed);
  assert.equal((await f.store.list(f.owner)).items.length, 0);
  await assert.rejects(
    f.store.update(f.owner, created.item.id, update),
    errorStatus(404),
  );
  assert.equal(next.item.createdAt, reopened.item.createdAt);
});

test("keyset pages preserve bigint IDs, do not duplicate deleted records and source deletion removes retained tombstones", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "select setval('personal_plan_items_id_seq',9007199254740992,false)",
  );
  const ids: string[] = [];
  for (let index = 0; index < 23; index++)
    ids.push(
      (await f.store.create(f.owner, { ...f.input(), title: `Шаг ${index}` }))
        .item.id,
    );
  assert.equal(ids[0], "9007199254740992");
  await f.store.remove(f.owner, ids[12]!, 1);
  const page = await f.store.list(f.owner);
  assert.equal(page.items.length, 20);
  assert.equal(page.items[0]!.id, ids.at(-1));
  const last = await f.store.list(f.owner, page.nextBefore!);
  assert.equal(last.items.length, 2);
  assert.equal(last.nextBefore, null);
  assert.equal(
    new Set([...page.items, ...last.items].map((value) => value.id)).size,
    22,
  );
  assert.equal((await f.store.list(f.other, page.nextBefore!)).items.length, 0);
  await f.db.query("delete from messages where id=$1", [f.message.id]);
  assert.equal(await count(f.db, "personal_plan_items"), 0);
});

test("capacity counts active rows, permits replay at the limit and frees one place after soft removal", async (t) => {
  const f = await fixture(t),
    original = f.input(),
    created = await f.store.create(f.owner, original);
  await f.db.query(
    `insert into personal_plan_items(user_id,source_message_id,operation_id,create_request_hash,title,details)
    select $1,$2,gen_random_uuid(),repeat('a',64),'Synthetic '||n,'' from generate_series(1,199) n`,
    [f.owner, f.message.id],
  );
  assert.equal(
    (await f.store.create(f.owner, original)).item.id,
    created.item.id,
  );
  await assert.rejects(f.store.create(f.owner, f.input()), errorStatus(409));
  await f.store.remove(f.owner, created.item.id, 1);
  await f.store.create(f.owner, f.input());
  assert.equal(
    (
      await f.db.query<{ count: number }>(
        "select count(*)::integer as count from personal_plan_items where deleted_at is null",
      )
    ).rows[0]!.count,
    200,
  );
});

test("current blocked or password-change-required owners cannot read, write or replay steps; corrupt stored DTOs are server failures", async (t) => {
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
        title: "No",
        details: "",
        status: "pending",
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
  // PostgreSQL btrim removes ordinary spaces; contracts reject a title that
  // becomes empty after trimming tabs. Privileged malformed data is not input.
  await f.db.query(
    "update personal_plan_items set title=$2,revision=revision+1,updated_at=clock_timestamp() where id=$1",
    [created.item.id, "\t"],
  );
  await assert.rejects(f.store.list(f.owner), errorStatus(500));
  await assert.rejects(f.store.create(f.owner, input), errorStatus(500));
});

test("edit and remove reject corrupt stored DTOs without repairing or tombstoning them", async (t) => {
  const f = await fixture(t);
  const created = await f.store.create(f.owner, f.input());
  // btrim removes spaces, not a lone tab: this is malformed to the public DTO
  // while every real database constraint and trigger remains enabled.
  await f.db.query(
    "update personal_plan_items set title=chr(9),revision=revision+1,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where id=$1",
    [created.item.id],
  );
  const snapshot = () =>
    f.db.query(
      "select title,details,status,revision::text,updated_at::text,deleted_at from personal_plan_items where id=$1",
      [created.item.id],
    );
  const before = (await snapshot()).rows;
  await assert.rejects(
    f.store.update(f.owner, created.item.id, {
      expectedRevision: 2,
      title: "Do not silently repair",
      details: "",
      status: "completed",
    }),
    errorStatus(500),
  );
  await assert.rejects(
    f.store.remove(f.owner, created.item.id, 2),
    errorStatus(500),
  );
  assert.deepEqual((await snapshot()).rows, before);
});

test("database guards keep creation identity and tombstones immutable and migration 29 upgrades existing data additively", async (t) => {
  const f = await fixture(t),
    first = await f.store.create(f.owner, f.input());
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
        `update personal_plan_items set ${clause},updated_at=clock_timestamp() where id=$1`,
        [first.item.id],
      ),
    );
  await f.store.remove(f.owner, first.item.id, 1);
  await assert.rejects(
    f.db.query(
      "update personal_plan_items set deleted_at=null,revision=revision+1,updated_at=clock_timestamp() where id=$1",
      [first.item.id],
    ),
  );
  await f.db.query("delete from users where id=$1", [f.owner]);
  assert.equal(await count(f.db, "personal_plan_items"), 0);

  const old = await connectDatabase("pglite://:memory:");
  t.after(() => old.close());
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(migrations))
    .filter((name) => /^\d+.*\.sql$/.test(name) && name < "0029")
    .sort())
    await old.exec(await readFile(new URL(name, migrations), "utf8"));
  const user = await new Repository(old).register(
    "upgrade-plan@example.test",
    "synthetic",
  );
  await old.exec(
    await readFile(new URL("0029_personal_plan.sql", migrations), "utf8"),
  );
  assert.equal(
    (await old.query("select id from users where id=$1", [user])).rows.length,
    1,
  );
  assert.equal(await count(old, "personal_plan_items"), 0);
});

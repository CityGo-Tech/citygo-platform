import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, type Database } from "./index.js";
import { DomainError } from "./errors.js";
import { ensureConversation } from "./conversation-start.js";

async function fixture(t: TestContext) {
  // Always synthetic and in memory; never consume an inherited DATABASE_URL.
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  return db;
}
async function user(db: Database, status = "active") {
  return (
    await db.query<{ id: string }>(
      "insert into users(auth_subject,status) values ($1,$2) returning id::text",
      [randomUUID(), status],
    )
  ).rows[0]!.id;
}
async function count(db: Database, table: string) {
  // All callers use the fixed test table list below, never request input.
  return (
    await db.query<{ count: number }>(
      `select count(*)::integer as count from ${table}`,
    )
  ).rows[0]!.count;
}

test("conversation starts as Support without an invented profile, plan, consent or quest", async (t) => {
  const db = await fixture(t);
  const owner = await user(db);
  const untouched = [
    "relocation_profiles",
    "questionnaire_answers",
    "relocation_plans",
    "user_quests",
    "xp_events",
    "messages",
    "agent_handoffs",
    "consent_events",
    "ai_consents",
    "chat_requests",
    "ai_model_attempts",
    "ai_usage_daily",
    "ai_user_usage_daily",
    "ai_credit_accounts",
    "ai_credit_entries",
  ];
  const before = await Promise.all(untouched.map((table) => count(db, table)));
  const thread = await ensureConversation(db, owner);
  assert.match(thread.id, /^[1-9]\d*$/);
  assert.equal(thread.agentKey, "support");
  assert.deepEqual(
    (
      await db.query(
        "select user_id::text,agent_key,status,context,busy_until,lease_token from agent_threads",
      )
    ).rows,
    [
      {
        user_id: owner,
        agent_key: "support",
        status: "open",
        context: {},
        busy_until: null,
        lease_token: null,
      },
    ],
  );
  assert.deepEqual(
    await Promise.all(untouched.map((table) => count(db, table))),
    before,
  );
  assert.deepEqual(await ensureConversation(db, owner), thread);
  assert.equal(await count(db, "agent_threads"), 1);
});

test("opening a conversation preserves its specialist, running reply and old messages", async (t) => {
  const db = await fixture(t);
  const owner = await user(db);
  const lease = randomUUID();
  const current = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status,context,busy_until,lease_token) values ($1,'resume-builder','handoff',$2,'2099-01-01',$3) returning id::text",
      [
        owner,
        JSON.stringify({ confirmed: "только слова пользователя" }),
        lease,
      ],
    )
  ).rows[0]!;
  await db.query(
    "insert into messages(thread_id,role,content) values ($1,'user','Пока не знаю бюджет')",
    [current.id],
  );
  const before = (await db.query("select * from agent_threads")).rows;
  const messages = (await db.query("select * from messages")).rows;
  assert.deepEqual(await ensureConversation(db, owner), {
    id: current.id,
    agentKey: "resume-builder",
  });
  assert.deepEqual(
    (await db.query("select * from agent_threads")).rows,
    before,
  );
  assert.deepEqual((await db.query("select * from messages")).rows, messages);
});

test("closed history stays closed and another account never receives that conversation", async (t) => {
  const db = await fixture(t);
  const first = await user(db);
  const second = await user(db);
  const closed = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status) values ($1,'housing','closed') returning id::text",
      [first],
    )
  ).rows[0]!;
  await db.query(
    "insert into messages(thread_id,role,content) values ($1,'assistant','Старая рекомендация')",
    [closed.id],
  );
  const firstThread = await ensureConversation(db, first);
  const secondThread = await ensureConversation(db, second);
  assert.notEqual(firstThread.id, closed.id);
  assert.notEqual(secondThread.id, firstThread.id);
  assert.equal(firstThread.agentKey, "support");
  assert.equal(secondThread.agentKey, "support");
  assert.deepEqual(
    (
      await db.query("select status from agent_threads where id=$1", [
        closed.id,
      ])
    ).rows,
    [{ status: "closed" }],
  );
  assert.equal(await count(db, "messages"), 1);
});

test("missing, blocked and deleted owners cannot start or reopen a conversation", async (t) => {
  const db = await fixture(t);
  const blocked = await user(db, "blocked");
  const deleted = await user(db, "deleted");
  for (const owner of [blocked, deleted]) {
    await assert.rejects(
      ensureConversation(db, owner),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 403,
    );
  }
  await assert.rejects(
    ensureConversation(db, "9223372036854775807"),
    (error: unknown) =>
      error instanceof DomainError && error.statusCode === 404,
  );
  assert.equal(await count(db, "agent_threads"), 0);
});

test("malformed owner IDs fail before accessing storage", async () => {
  let transactions = 0;
  const db: Database = {
    async transaction() {
      transactions++;
      throw new Error("Unexpected database access");
    },
    async query() {
      throw new Error("Unexpected database access");
    },
    async exec() {
      throw new Error("Unexpected database access");
    },
    async close() {},
  };
  for (const owner of [
    "",
    "0",
    "-1",
    "01",
    " 1",
    "1 ",
    "1.0",
    "1e2",
    "9223372036854775808",
    "1; delete from users",
  ]) {
    await assert.rejects(
      ensureConversation(db, owner),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 400,
    );
  }
  assert.equal(transactions, 0);
});

test("creation locks the owner before reading and inserting the active thread", async (t) => {
  const db = await fixture(t);
  const owner = await user(db);
  const queries: string[] = [];
  const observed: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: (sql, params) => {
            queries.push(sql);
            return tx.query(sql, params);
          },
        }),
      ),
  };
  // PGlite serializes transactions. This checks idempotency and the lock SQL,
  // not a claim to have reproduced independent PostgreSQL connection races.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => ensureConversation(observed, owner)),
  );
  assert.equal(new Set(results.map((value) => value.id)).size, 1);
  assert.equal(await count(db, "agent_threads"), 1);
  assert.match(queries[0]!, /from users where id=\$1 for update/);
  assert.match(
    queries[1]!,
    /from agent_threads[\s\S]*user_id=\$1[\s\S]*for update/,
  );
  assert.match(queries[2]!, /insert into agent_threads/);
  assert.ok(
    queries.every(
      (sql) =>
        !/relocation_profiles|questionnaire_answers|relocation_plans|xp_events/.test(
          sql,
        ),
    ),
  );
});

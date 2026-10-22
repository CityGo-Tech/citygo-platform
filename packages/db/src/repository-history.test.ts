import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Message } from "@citygo/contracts";
import { connectDatabase, migrate, type Database } from "./index.js";
import { Repository } from "./repository.js";

async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  const database = "history_test_" + randomUUID().replaceAll("-", "");
  assert.match(database, /^history_test_[a-f0-9]{32}$/);
  let admin: Database | undefined,
    created = false;
  const cleanup: { db?: Database } = {};
  // Register before setup: failed connects/migrations still close this fixture's
  // connections and drop only its generated database, never the supplied base.
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [
      async () => cleanup.db?.close(),
      async () => {
        if (created) await admin!.query(`drop database "${database}"`);
      },
      async () => admin?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic history cleanup failed");
  });
  let url = "pglite://:memory:";
  if (base) {
    let scoped: URL;
    try {
      scoped = new URL(base);
    } catch {
      throw new Error("Requires a valid disposable PostgreSQL test target");
    }
    assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(scoped.hostname));
    assert.ok(
      ((scoped.port || "5432") === "5432" &&
        scoped.pathname === "/citygo_test") ||
        (scoped.port === "55438" && scoped.pathname === "/citygo_synthetic"),
      "Requires the disposable CI or local synthetic PostgreSQL target",
    );
    assert.equal(scoped.search, "");
    assert.equal(scoped.hash, "");
    admin = await connectDatabase(base);
    await admin.query(`create database "${database}" template template0`);
    created = true;
    scoped.pathname = "/" + database;
    url = scoped.toString();
  }
  const db = await connectDatabase(url);
  cleanup.db = db;
  await migrate(db);
  const users = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject) values ('synthetic-history-owner'),('synthetic-history-other') returning id::text",
    )
  ).rows;
  const threads = [];
  for (const user of users)
    threads.push(
      (
        await db.query<{ id: string }>(
          "insert into agent_threads(user_id,agent_key) values ($1,'housing') returning id::text",
          [user.id],
        )
      ).rows[0]!.id,
    );
  return {
    db,
    repo: new Repository(db),
    thread: threads[0]!,
    otherThread: threads[1]!,
  };
}

async function insertMessage(
  db: Database,
  thread: string,
  id: string,
  role: Message["role"] | "system" | "tool" = "assistant",
  metadata: Record<string, unknown> = {},
) {
  const content = "Synthetic message " + id;
  await db.query(
    "insert into messages(id,thread_id,role,content,metadata) overriding system value values ($1,$2,$3,$4,$5)",
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

for (const ids of [
  ["8", "9", "10", "11"],
  ["98", "99", "100", "101"],
])
  test(`chat history follows numeric IDs across ${ids[1]} → ${ids[2]}, not text aliases`, async (t) => {
    const f = await fixture(t);
    for (const id of [...ids].reverse())
      await insertMessage(f.db, f.thread, id);
    const history = await f.repo.history(f.db, f.thread);
    assert.deepEqual(
      history.map((message) => message.id),
      ids,
    );
    assert.ok(history.every((message) => typeof message.id === "string"));
  });

test("chat history returns the latest 100 eligible numeric IDs ascending with unchanged message metadata", async (t) => {
  const f = await fixture(t);
  const expected = [];
  const generation = {
    provider: "routerai",
    requestedModel: "synthetic/model",
    model: "synthetic/model",
    usage: { inputTokens: 10, outputTokens: 20 },
  };
  for (let id = 1; id <= 130; id++) {
    const role = id === 101 || id % 2 === 0 ? "assistant" : "user";
    const metadata =
      id === 100
        ? {
            agentKey: "work",
            status: "complete",
            generation,
            citygoFavorite: true,
          }
        : id === 101
          ? { agentKey: "housing", status: "interrupted", generation }
          : id === 102
            ? {
                agentKey: "housing",
                status: "interrupted",
                source: "system",
                failureCode: "AI_CREDIT_EXHAUSTED",
                citygoFavorite: true,
              }
            : {};
    expected.push(
      await insertMessage(f.db, f.thread, String(id), role, metadata),
    );
  }
  // Higher foreign/system/tool rows must not displace this thread's latest 100
  // user/assistant messages. The numeric selection happens before reversal.
  await insertMessage(f.db, f.otherThread, "2000", "user");
  await insertMessage(f.db, f.otherThread, "2001", "assistant");
  await insertMessage(f.db, f.thread, "2002", "system");
  await insertMessage(f.db, f.thread, "2003", "tool");
  const history = await f.repo.history(f.db, f.thread);
  assert.equal(history.length, 100);
  assert.deepEqual(history, expected.slice(-100));
  assert.equal(history[0]!.id, "31");
  assert.equal(history.at(-1)!.id, "130");
  assert.deepEqual(
    (await f.repo.history(f.db, f.otherThread)).map((message) => message.id),
    ["2000", "2001"],
  );
});

test("chat history keeps bigint IDs as exact strings without JavaScript numeric sorting", async (t) => {
  const f = await fixture(t);
  const ids = ["9007199254740991", "9007199254740992", "9007199254740993"];
  for (const id of [...ids].reverse()) await insertMessage(f.db, f.thread, id);
  assert.deepEqual(
    (await f.repo.history(f.db, f.thread)).map((message) => message.id),
    ids,
  );
});

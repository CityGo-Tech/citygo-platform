import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  MessageFavorites,
  Repository,
} from "./index.js";

test(
  "PostgreSQL: favorites search filters literal Unicode text, assistant and author before keyset pages",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires explicitly disposable local PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const admin = await connectDatabase(url.href);
    const name = "cg_favorites_" + randomUUID().replaceAll("-", "");
    await admin.exec(`create database ${name} template template0`);
    url.pathname = "/" + name;
    const db = await connectDatabase(url.href);
    t.after(async () => {
      await db.close();
      try {
        await admin.exec(`drop database ${name}`);
      } finally {
        await admin.close();
      }
    });
    await migrate(db);
    const repo = new Repository(db);
    const owner = await repo.register("favorites-pg@example.test", "synthetic");
    const other = await repo.register(
      "favorites-other-pg@example.test",
      "synthetic",
    );
    const threads: string[] = [];
    for (const user of [owner, other])
      threads.push(
        (
          await db.query<{ id: string }>(
            "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
            [user],
          )
        ).rows[0]!.id,
      );
    const text = "Москва 50%_\\route";
    const meta = {
      citygoFavorite: true,
      agentKey: "support",
      status: "complete",
    };
    for (let i = 0; i < 24; i++)
      await db.query(
        "insert into messages(thread_id,role,content,metadata) values($1,'assistant',$2,$3)",
        [threads[0], text + " " + i, JSON.stringify(meta)],
      );
    for (const [thread, role, content, agent] of [
      [threads[1], "assistant", text, "support"],
      [threads[0], "user", text, "support"],
      [threads[0], "assistant", text, "housing"],
      [threads[0], "assistant", "Москва 50abroute", "support"],
    ])
      await db.query(
        "insert into messages(thread_id,role,content,metadata) values($1,$2,$3,$4)",
        [thread, role, content, JSON.stringify({ ...meta, agentKey: agent })],
      );
    const store = new MessageFavorites(db);
    const filters = {
      search: "МОСКВА 50%_\\route",
      assistantKey: "support" as const,
      role: "assistant" as const,
    };
    const first = await store.list(owner, undefined, filters);
    assert.equal(first.messages.length, 20);
    assert.ok(first.nextBefore);
    const second = await store.list(owner, first.nextBefore!, filters);
    assert.equal(second.messages.length, 4);
    assert.equal(second.nextBefore, null);
    assert.equal(
      new Set([...first.messages, ...second.messages].map((m) => m.id)).size,
      24,
    );
    assert.ok(
      [...first.messages, ...second.messages].every(
        (m) =>
          m.content.startsWith(text) &&
          m.role === "assistant" &&
          m.agentKey === "support",
      ),
    );
    assert.deepEqual(
      (await store.list(other, undefined, { search: "not a match%" })).messages,
      [],
    );
    for (const table of [
      "ai_credit_entries",
      "ai_model_attempts",
      "payment_topup_orders",
    ])
      assert.equal((await db.query("select 1 from " + table)).rows.length, 0);
  },
);

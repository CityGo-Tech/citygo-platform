import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  exportConversation,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
test(
  "PostgreSQL: export keeps existing API grants, exact old rows, and rechecks an owner blocked behind a lock",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires explicitly supplied disposable loopback PostgreSQL",
    timeout: 30000,
  },
  async (t) => {
    const base = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(base.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
    assert.equal(base.search, "");
    assert.equal(base.hash, "");
    assert.ok(
      ((base.port || "5432") === "5432" && base.pathname === "/citygo_test") ||
        (base.port === "55438" &&
          ["/citygo_synthetic", "/citygo_history_synthetic"].includes(
            base.pathname,
          )),
      "Only explicit disposable CI/local DB",
    );
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cgexport_" + suffix,
      admin = await connectDatabase(base.toString());
    const connections: { db?: Database } = {};
    let created = false;
    const made: string[] = [];
    const roles = {
      citygo_api: "cgexp_api_" + suffix,
      citygo_worker: "cgexp_worker_" + suffix,
      citygo_backup: "cgexp_backup_" + suffix,
    };
    t.after(async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        async () => {
          for (const role of made.reverse())
            await connections.db!.exec(
              `drop owned by ${role};drop role ${role}`,
            );
        },
        async () => connections.db?.close(),
        async () => {
          if (created) await admin.exec(`drop database ${name}`);
        },
        async () => admin.close(),
      ])
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Owned export fixture cleanup failed",
        );
    });
    await admin.exec(`create database ${name} template template0`);
    created = true;
    base.pathname = "/" + name;
    const backend = await connectDatabase(base.toString());
    connections.db = backend;
    await migrate(backend);
    for (const role of Object.values(roles)) {
      await backend.exec(
        `create role ${role} nologin;grant usage on schema public to ${role}`,
      );
      made.push(role);
    }
    const grants = (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    )
      .replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, "")
      .replace(
        /\bcitygo_(api|worker|backup)\b/g,
        (role) => roles[role as keyof typeof roles],
      );
    await backend.exec(grants);
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        return work(tx);
      });
    const runtime: Database = {
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      exec: () => assert.fail("Export must not execute runtime commands"),
      transaction: asApi,
      close: async () => {},
    };
    const users = (
      await backend.query<{ id: string }>(
        "insert into users(auth_subject)values($1),($2)returning id::text",
        [randomUUID(), randomUUID()],
      )
    ).rows;
    const owner = users[0]!.id,
      other = users[1]!.id;
    await backend.query("update users set role='super_admin' where id=$1", [
      other,
    ]);
    const thread = (
      await backend.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,status)values($1,'support','closed')returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    await backend.query(
      "insert into messages(id,thread_id,role,content,metadata)overriding system value select 9007199254740991+i,$1,case when i%2=0 then 'assistant' else 'user' end,'Synthetic old text '||i,'{\"agentKey\":\"support\",\"status\":\"complete\"}'::jsonb from generate_series(1,180)i",
      [thread],
    );
    const before = (
      await backend.query(
        "select to_jsonb(m)::text as row from messages m order by id",
      )
    ).rows;
    const value = await exportConversation(runtime, owner, thread);
    assert.equal(value.messages.length, 180);
    assert.equal(value.messages[0]!.id, "9007199254740992");
    assert.equal(value.messages.at(-1)!.id, "9007199254741171");
    assert.deepEqual(
      (
        await backend.query(
          "select to_jsonb(m)::text as row from messages m order by id",
        )
      ).rows,
      before,
    );
    await assert.rejects(
      exportConversation(runtime, other, thread),
      (error) => error instanceof DomainError && error.statusCode === 404,
    );
    let unlock!: () => void, locked!: () => void;
    const hold = new Promise<void>((resolve) => (unlock = resolve)),
      ready = new Promise<void>((resolve) => (locked = resolve));
    const writer = backend.transaction(async (tx) => {
      await tx.query("update users set status='blocked' where id=$1", [owner]);
      locked();
      await hold;
    });
    await ready;
    let settled = false;
    const pending = exportConversation(runtime, owner, thread).finally(
      () => (settled = true),
    );
    const outcome = assert.rejects(
      pending,
      (error) => error instanceof DomainError && error.statusCode === 403,
    );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const n = (
          await backend.query<{ n: number }>(
            "select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select status,must_change_password from users%for share'",
          )
        ).rows[0]!.n;
        if (n) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      assert.equal(settled, false);
    } finally {
      unlock();
      await writer;
    }
    await outcome;
  },
);

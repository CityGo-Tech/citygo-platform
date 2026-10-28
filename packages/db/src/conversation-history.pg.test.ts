import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { conversationMessagesResponseSchema } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  ensureConversation,
  type Database,
  type Sql,
} from "./index.js";
import { Repository, DomainError } from "./repository.js";

test(
  "PostgreSQL: history pages use existing runtime grants, retain exact rows and recheck locked owner state",
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
    assert.ok(
      ((base.port || "5432") === "5432" && base.pathname === "/citygo_test") ||
        (base.port === "55438" &&
          ["/citygo_synthetic", "/citygo_history_synthetic"].includes(
            base.pathname,
          )),
      "Only the disposable CI/local history database is allowed",
    );
    assert.equal(base.search, "");
    assert.equal(base.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cghistory_" + suffix;
    const admin = await connectDatabase(base.toString());
    const connections: { db?: Database } = {};
    let created = false;
    const roles = {
      citygo_api: "cghist_api_" + suffix,
      citygo_worker: "cghist_worker_" + suffix,
      citygo_backup: "cghist_backup_" + suffix,
    };
    const createdRoles: string[] = [];
    t.after(async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        async () => {
          for (const role of createdRoles.reverse())
            await connections.db!.exec(
              `drop owned by ${role}; drop role ${role}`,
            );
        },
        async () => connections.db?.close(),
        async () => {
          if (created) await admin.exec(`drop database ${name}`);
        },
        async () => admin.close(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Owned history PostgreSQL fixture cleanup failed",
        );
    });
    await admin.exec(`create database ${name} template template0`);
    created = true;
    base.pathname = "/" + name;
    const db = await connectDatabase(base.toString());
    connections.db = db;
    const backend = db;
    await migrate(backend);
    for (const role of Object.values(roles)) {
      await backend.exec(
        `create role ${role} nologin; grant usage on schema public to ${role}`,
      );
      createdRoles.push(role);
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
    const asRole = <T>(role: string, work: (tx: Sql) => Promise<T>) =>
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        return work(tx);
      });
    const runtime: Database = {
      query: <T>(sql: string, params?: unknown[]) =>
        asRole(roles.citygo_api, (tx) => tx.query<T>(sql, params)),
      exec: (sql) => asRole(roles.citygo_api, (tx) => tx.exec(sql)),
      transaction: (work) => asRole(roles.citygo_api, work),
      close: async () => {},
    };
    const repo = new Repository(runtime);
    const users = (
      await backend.query<{ id: string }>(
        "insert into users(auth_subject) values($1),($2),($3) returning id::text",
        [randomUUID(), randomUUID(), randomUUID()],
      )
    ).rows.map((row) => row.id);
    const owner = users[0]!,
      other = users[1]!,
      superAdmin = users[2]!;
    await backend.query("update users set role='super_admin' where id=$1", [
      superAdmin,
    ]);
    const thread = (await ensureConversation(runtime, owner, "housing")).id;
    const foreign = (await ensureConversation(runtime, other, "housing")).id;
    const baseId = 9007199254740991n;
    await backend.query(
      `insert into messages(id,thread_id,role,content,created_at) overriding system value
     select $1::bigint+i,$2::bigint,case when i%6=0 then 'tool' when i%6=3 then 'system' when i%2=0 then 'assistant' else 'user' end,
      'Synthetic history '||i::text,case when i%2=0 then '2026-01-01'::timestamptz else '2026-12-01'::timestamptz end
     from generate_series(1,390) as i`,
      [baseId.toString(), thread],
    );
    const foreignId = (baseId + 1000n).toString();
    await backend.query(
      "insert into messages(id,thread_id,role,content) overriding system value values($1,$2,'user','Synthetic foreign')",
      [foreignId, foreign],
    );
    await backend.query(
      "update agent_threads set status='closed' where id=$1",
      [thread],
    );
    await backend.query("insert into ai_credit_accounts(user_id) values($1)", [
      owner,
    ]);
    const snapshot = async () => {
      const result: Record<string, unknown> = {};
      for (const { tablename } of (
        await backend.query<{ tablename: string }>(
          "select tablename from pg_tables where schemaname='public' order by tablename",
        )
      ).rows) {
        assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
        result[tablename] = (
          await backend.query(
            `select to_jsonb(t)::text as value from ${tablename} t order by to_jsonb(t)::text`,
          )
        ).rows;
      }
      for (const { sequencename } of (
        await backend.query<{ sequencename: string }>(
          "select sequencename from pg_sequences where schemaname='public' order by sequencename",
        )
      ).rows) {
        assert.match(sequencename, /^[a-z_][a-z0-9_]*$/);
        result["sequence:" + sequencename] = (
          await backend.query(
            `select last_value::text,is_called from ${sequencename}`,
          )
        ).rows;
      }
      return result;
    };
    const beforeRows = await snapshot();
    const ids: string[] = [],
      sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await repo.conversationMessages(owner, thread, cursor);
      conversationMessagesResponseSchema.parse(page);
      sizes.push(page.messages.length);
      ids.unshift(...page.messages.map((message) => message.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(sizes, [100, 100, 60]);
    assert.deepEqual(
      ids,
      Array.from({ length: 390 }, (_, i) => i + 1)
        .filter((i) => i % 6 !== 0 && i % 6 !== 3)
        .map((i) => (baseId + BigInt(i)).toString()),
    );
    // The exact old source is outside the latest100 view, while the restricted
    // API role can read its bounded inclusive window with the existing grants.
    const sourceId = ids[103]!;
    const context = await repo.conversationMessageContext(
      owner,
      thread,
      sourceId,
    );
    conversationMessagesResponseSchema.parse(context);
    assert.deepEqual(
      context.messages.map((message) => message.id),
      ids.slice(4, 104),
    );
    assert.equal(context.messages.at(-1)!.id, sourceId);
    assert.equal(context.nextCursor, ids[4]);
    assert.ok(
      !(await repo.conversationMessages(owner, thread)).messages.some(
        (message) => message.id === sourceId,
      ),
    );
    assert.deepEqual(
      (
        await repo.conversationMessages(owner, thread, context.nextCursor!)
      ).messages.map((message) => message.id),
      ids.slice(0, 4),
    );
    const missing = (error: unknown) =>
      error instanceof DomainError && error.statusCode === 404;
    for (const actor of [other, superAdmin]) {
      await assert.rejects(repo.conversationMessages(actor, thread), missing);
      await assert.rejects(
        repo.conversationMessageContext(actor, thread, sourceId),
        missing,
      );
    }
    for (const badCursor of [
      foreignId,
      (baseId + 3n).toString(),
      (baseId + 6n).toString(),
      "9223372036854775807",
    ])
      await assert.rejects(
        repo.conversationMessages(owner, thread, badCursor),
        missing,
      );
    assert.deepEqual(await snapshot(), beforeRows);
    await assert.rejects(
      asRole(roles.citygo_worker, (tx) =>
        tx.query("select id from messages limit 1"),
      ),
      { code: "42501" },
    );

    // Use an independently acquired owner update lock. The page cannot pass its
    // account recheck while that update is uncommitted, then sees blocked state.
    let unlock!: () => void, locked!: () => void;
    const hold = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = backend.transaction(async (tx) => {
      await tx.query("update users set status='blocked' where id=$1", [owner]);
      locked();
      await hold;
    });
    await lockReady;
    let settled = false,
      contextSettled = false;
    const pending = repo.conversationMessages(owner, thread).finally(() => {
      settled = true;
    });
    const pendingContext = repo
      .conversationMessageContext(owner, thread, sourceId)
      .finally(() => {
        contextSettled = true;
      });
    // Attach rejection handling immediately, including on a diagnostic assertion.
    const outcome = assert.rejects(
      pending,
      (error) => error instanceof DomainError && error.statusCode === 403,
    );
    const contextOutcome = assert.rejects(
      pendingContext,
      (error) => error instanceof DomainError && error.statusCode === 403,
    );
    try {
      let waited = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        const waiting = (
          await backend.query<{ n: number }>(
            "select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select status,must_change_password from users%for share'",
          )
        ).rows[0]!.n;
        if (waiting >= 2) {
          waited = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waited, true);
      assert.equal(settled, false);
      assert.equal(contextSettled, false);
    } finally {
      unlock();
      await writer;
    }
    await Promise.all([outcome, contextOutcome]);
  },
);

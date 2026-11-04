import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  ConversationMemory,
  ensureConversation,
  type Database,
  type Sql,
} from "./index.js";
import { indexConversationMemoryMessage } from "./conversation-memory.js";

test(
  "PostgreSQL: independent memory backfills serialize idempotently with restricted grants, original source proof and no Worker access",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires explicitly supplied disposable loopback PostgreSQL",
    timeout: 120000,
  },
  async (t) => {
    const base = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(base.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
    assert.ok(
      ((base.port || "5432") === "5432" && base.pathname === "/citygo_test") ||
        (base.port === "55438" && base.pathname === "/citygo_synthetic"),
    );
    assert.equal(base.search, "");
    assert.equal(base.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cgmemory_" + suffix;
    const admin = await connectDatabase(base.toString());
    let created = false;
    const opened: Database[] = [],
      createdRoles: string[] = [];
    const cleanup: { backend?: Database } = {};
    const roles = {
      citygo_api: "cgmem_api_" + suffix,
      citygo_worker: "cgmem_worker_" + suffix,
      citygo_backup: "cgmem_backup_" + suffix,
    };
    t.after(async () => {
      const errors: unknown[] = [];
      for (const db of opened.reverse())
        try {
          await db.close();
        } catch (error) {
          errors.push(error);
        }
      if (cleanup.backend) {
        const backend = cleanup.backend;
        for (const role of createdRoles.reverse())
          try {
            await backend.exec(`drop owned by ${role};drop role ${role}`);
          } catch (error) {
            errors.push(error);
          }
        try {
          await backend.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (created)
        try {
          await admin.exec(`drop database ${name}`);
        } catch (error) {
          errors.push(error);
        }
      try {
        await admin.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(
          errors,
          "Owned memory PostgreSQL fixture cleanup failed",
        );
    });
    await admin.exec(`create database ${name} template template0`);
    created = true;
    base.pathname = "/" + name;
    const backend = await connectDatabase(base.toString());
    cleanup.backend = backend;
    await migrate(backend);
    for (const role of Object.values(roles)) {
      await backend.exec(
        `create role ${role} nologin;grant usage on schema public to ${role}`,
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
    const owner = (
      await backend.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [suffix],
      )
    ).rows[0]!.id;
    const thread = (await ensureConversation(backend, owner, "housing")).id;
    await backend.query(
      "insert into messages(thread_id,role,content) select $1,'user','Работа на Кутузовском проспекте. Исходное условие '||i::text from generate_series(1,12)i",
      [thread],
    );
    await backend.query(
      "insert into messages(thread_id,role,content)values($1,'user',$2)",
      [thread, "😀".repeat(100_000)],
    );
    const asRole = <T>(
      db: Database,
      role: string,
      work: (tx: Sql) => Promise<T>,
    ) =>
      db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        return work(tx);
      });
    const runtime = (db: Database): Database => ({
      query: <T>(sql: string, params?: unknown[]) =>
        asRole(db, roles.citygo_api, (tx) => tx.query<T>(sql, params)),
      exec: (sql) => asRole(db, roles.citygo_api, (tx) => tx.exec(sql)),
      transaction: (work) => asRole(db, roles.citygo_api, work),
      close: async () => {},
    });
    const first = await connectDatabase(base.toString()),
      second = await connectDatabase(base.toString());
    opened.push(first, second);
    const a = runtime(first),
      b = runtime(second);
    const pids = await Promise.all(
      [a, b].map(
        async (db) =>
          (await db.query<{ pid: number }>("select pg_backend_pid() as pid"))
            .rows[0]!.pid,
      ),
    );
    assert.notEqual(pids[0], pids[1]);
    const [left, right] = await Promise.all([
      new ConversationMemory(a).snapshot(owner, thread, "Кутузовский"),
      new ConversationMemory(b).snapshot(owner, thread, "Кутузовский"),
    ]);
    assert.equal(left.indexComplete, true);
    assert.equal(right.indexComplete, true);
    assert.equal(
      (await backend.query("select * from conversation_memory_fragments")).rows
        .length,
      112,
    );
    assert.deepEqual(left.fragments, right.fragments);
    const denied = (error: unknown) =>
      (error as { code?: string }).code === "42501";
    for (const statement of [
      "delete from conversation_memory_fragments",
      "truncate conversation_memory_fragments",
      "update conversation_memory_fragments set content='forged'",
      "update messages set content='forged' where role='user'",
    ])
      await assert.rejects(a.exec(statement), denied);
    await assert.rejects(
      asRole(first, roles.citygo_worker, (tx) =>
        tx.query("select * from conversation_memory_fragments"),
      ),
      denied,
    );
    assert.equal(
      (
        await asRole(first, roles.citygo_backup, (tx) =>
          tx.query("select * from conversation_memory_fragments"),
        )
      ).rows.length,
      112,
    );
    const before = (
      await backend.query(
        "select * from conversation_memory_fragments order by message_id,ordinal",
      )
    ).rows;
    await new ConversationMemory(a).snapshot(owner, thread, "Кутузовский", {
      readOnly: true,
    });
    assert.deepEqual(
      (
        await backend.query(
          "select * from conversation_memory_fragments order by message_id,ordinal",
        )
      ).rows,
      before,
    );
    await assert.rejects(
      a.transaction(async (tx) => {
        const id = (
          await tx.query<{ id: string }>(
            "insert into messages(thread_id,role,content)values($1,'user','rollback')returning id::text",
            [thread],
          )
        ).rows[0]!.id;
        await indexConversationMemoryMessage(tx, owner, thread, id);
        throw new Error("rollback fixture");
      }),
      /rollback fixture/,
    );
    assert.deepEqual(
      (
        await backend.query(
          "select * from conversation_memory_fragments order by message_id,ordinal",
        )
      ).rows,
      before,
    );
    await t.test(
      "100x100k originals / 10,000 quotations stay within the PostgreSQL deadline and hash each source once",
      async () => {
        const largeThread = (
          await ensureConversation(backend, owner, "job-search")
        ).id;
        const base = "Условия жилья: работа, школа, семья и бюджет. ";
        const content = base
          .repeat(Math.ceil(100000 / base.length))
          .slice(0, 100000);
        const ids = (
          await a.query<{ id: string }>(
            "insert into messages(thread_id,role,content) select $1,'user',$2 from generate_series(1,100) returning id::text",
            [largeThread, content],
          )
        ).rows;
        const startedWarm = performance.now();
        for (const { id } of ids)
          await indexConversationMemoryMessage(a, owner, largeThread, id);
        assert.equal(
          (
            await a.query<{ n: number }>(
              "select count(*)::int as n from conversation_memory_fragments where thread_id=$1",
              [largeThread],
            )
          ).rows[0]!.n,
          10000,
        );
        const statements: { sql: string; params?: unknown[] }[] = [];
        const perf: Database = {
          ...a,
          transaction: (work) =>
            asRole(first, roles.citygo_api, async (tx) => {
              await tx.exec("set local statement_timeout='5s'");
              return work({
                exec: (sql) => tx.exec(sql),
                query: <T>(sql: string, params?: unknown[]) => {
                  if (sql.includes("/* conversation-memory-snapshot */"))
                    statements.push({ sql, params });
                  return tx.query<T>(sql, params);
                },
              });
            }),
        };
        const started = performance.now();
        const result = await new ConversationMemory(perf).snapshot(
          owner,
          largeThread,
          "работа школа бюджет",
          { readOnly: true },
        );
        t.diagnostic(
          `Actual PostgreSQL: 100x100k sources, 10,000 quotations, warm index ${Math.round(started - startedWarm)} ms, snapshot ${Math.round(performance.now() - started)} ms; no provider calls`,
        );
        assert.equal(result.indexComplete, true);
        assert.equal(result.indexedMessages, 100);
        assert.equal(result.complete, false);
        assert.equal(result.fragments.length, 32);
        assert.equal(statements.length, 1);
        const statement = statements[0]!;
        const plan = await asRole(first, roles.citygo_api, async (tx) => {
          await tx.exec("set local statement_timeout='5s'");
          return tx.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
            "explain(analyze,buffers,format json) " + statement.sql,
            statement.params,
          );
        });
        const nodes = planNodes(plan.rows[0]!["QUERY PLAN"][0]!.Plan);
        for (const name of ["sources", "indexed", "verified"]) {
          const node = nodes.find(
            (row) => row["Subplan Name"] === "CTE " + name,
          )!;
          assert.equal(node["Actual Loops"], 1);
          assert.equal(node["Actual Rows"], 100);
        }
        assert.equal(
          nodes.find((row) => row["Subplan Name"] === "CTE candidates")![
            "Actual Rows"
          ],
          32,
        );
      },
    );
  },
);

type PlanNode = { [key: string]: unknown; Plans?: PlanNode[] };
const planNodes = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(planNodes),
];

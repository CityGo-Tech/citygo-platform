import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  MessageFavorites,
  type Database,
  type Sql,
} from "./index.js";

test(
  "PostgreSQL: actual column grants allow private bookmarks but not rewriting messages; concurrent metadata survives",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires an explicitly supplied disposable PostgreSQL",
    timeout: 30000,
  },
  async (t) => {
    const base = process.env.TEST_DATABASE_URL!;
    const url = new URL(base);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname),
      "Only a disposable loopback PostgreSQL",
    );
    const suffix = randomUUID().replaceAll("-", "");
    const name = "cg_favorites_" + suffix;
    const admin = await connectDatabase(base);
    const created: string[] = [];
    const cleanup: { db?: Database } = {};
    let databaseCreated = false;
    t.after(async () => {
      try {
        if (cleanup.db) {
          for (const role of created.reverse())
            await cleanup.db.exec(`drop owned by ${role}; drop role ${role}`);
          await cleanup.db.close();
        }
        if (databaseCreated) await admin.exec(`drop database ${name}`);
      } finally {
        await admin.close();
      }
    });
    await admin.exec(`create database ${name} template template0`);
    databaseCreated = true;
    url.pathname = "/" + name;
    const db = await connectDatabase(url.toString());
    cleanup.db = db;
    await migrate(db);
    const roles = {
      citygo_api: "cgfav_api_" + suffix,
      citygo_worker: "cgfav_worker_" + suffix,
      citygo_backup: "cgfav_backup_" + suffix,
    };
    for (const role of Object.values(roles)) {
      await db.exec(
        `create role ${role} nologin; grant usage on schema public to ${role}`,
      );
      created.push(role);
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
        (name) => roles[name as keyof typeof roles],
      );
    await db.exec(grants);
    const backend = db;
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        return work(tx);
      });
    const runtime: Database = {
      ...db,
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
    };
    const owner = await new Repository(runtime).register(
      "pg-favorite@example.test",
      "synthetic",
    );
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    const id = (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content,metadata) values($1,'user','KEEP','{}') returning id::text",
        [thread],
      )
    ).rows[0]!.id;
    const store = new MessageFavorites(runtime);
    await Promise.all([
      store.set(owner, id, true),
      store.set(owner, id, true),
      db.query(
        "update messages set metadata=jsonb_set(metadata,'{independent}', 'true'::jsonb) where id=$1",
        [id],
      ),
    ]);
    assert.equal((await store.list(owner)).messages.length, 1);
    const metadata = (
      await db.query<{ metadata: object }>(
        "select metadata from messages where id=$1",
        [id],
      )
    ).rows[0]!.metadata;
    assert.deepEqual(metadata, { citygoFavorite: true, independent: true });
    for (const column of ["content", "role", "thread_id"])
      await assert.rejects(
        runtime.query(`update messages set ${column}=${column} where id=$1`, [
          id,
        ]),
        { code: "42501" },
      );
    await assert.rejects(
      runtime.query("delete from messages where id=$1", [id]),
      { code: "42501" },
    );
    await store.set(owner, id, false);
    assert.equal((await store.list(owner)).messages.length, 0);
    await db.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_worker}`);
      await assert.rejects(tx.query("select metadata from messages"), {
        code: "42501",
      });
    });
  },
);

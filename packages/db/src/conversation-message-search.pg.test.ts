import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  ConversationMessageSearch,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
test(
  "PostgreSQL: message search uses existing runtime grants and rechecks an owner blocked during lock wait",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires an explicitly supplied disposable PostgreSQL",
    timeout: 30000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_search_" + suffix,
      admin = await connectDatabase(url.toString());
    const roles = {
      citygo_api: "cgsearch_api_" + suffix,
      citygo_worker: "cgsearch_worker_" + suffix,
      citygo_backup: "cgsearch_backup_" + suffix,
    };
    const cleanup: { db?: Database; other?: Database; release?: () => void } =
      {};
    let created = false;
    const createdRoles: string[] = [];
    t.after(async () => {
      try {
        cleanup.release?.();
        if (cleanup.other) await cleanup.other.close();
        if (cleanup.db) {
          for (const role of createdRoles.reverse())
            await cleanup.db.exec(`drop owned by ${role};drop role ${role}`);
          await cleanup.db.close();
        }
        if (created) await admin.exec(`drop database ${name}`);
      } finally {
        await admin.close();
      }
    });
    await admin.exec(`create database ${name} template template0`);
    created = true;
    url.pathname = "/" + name;
    const db = await connectDatabase(url.toString());
    cleanup.db = db;
    await migrate(db);
    const other = await connectDatabase(url.toString());
    cleanup.other = other;
    for (const role of Object.values(roles)) {
      await db.exec(
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
    await db.exec(grants);
    const backend = db;
    let onOwnerRead = () => {};
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        return work({
          exec: (s) => tx.exec(s),
          query: (s, v) => {
            if (s.startsWith("select status,must_change_password"))
              onOwnerRead();
            return tx.query(s, v);
          },
        });
      });
    const runtime: Database = {
      ...backend,
      query: <T>(s: string, v?: unknown[]) => asApi((tx) => tx.query<T>(s, v)),
      exec: (s) => asApi((tx) => tx.exec(s)),
      transaction: asApi,
    };
    const owner = (
      await db.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [suffix],
      )
    ).rows[0]!.id;
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key)values($1,'support')returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    await db.query(
      "insert into messages(id,thread_id,role,content)overriding system value values('9007199254740993',$1,'user',$2)",
      [thread, "Москва 50%_\\route"],
    );
    const reader = new ConversationMessageSearch(runtime);
    assert.equal(
      (await reader.list(owner, thread, { search: "москва 50%_\\route" }))
        .matches[0]!.messageId,
      "9007199254740993",
    );
    let release = () => {},
      written = () => {},
      entered = () => {};
    const gate = new Promise<void>((r) => (release = r)),
      updated = new Promise<void>((r) => (written = r)),
      readStarted = new Promise<void>((r) => (entered = r));
    cleanup.release = release;
    const blocker = other.transaction(async (tx) => {
      await tx.query("update users set status='blocked' where id=$1", [owner]);
      written();
      await gate;
    });
    await updated;
    onOwnerRead = entered;
    const pending = reader.list(owner, thread, { search: "Москва" });
    await readStarted;
    release();
    await blocker;
    await assert.rejects(
      pending,
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
  },
);

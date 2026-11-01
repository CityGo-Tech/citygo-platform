import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  ConversationTitles,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
test(
  "PostgreSQL title CAS serializes real concurrent writers, uses narrow runtime grants and rechecks a blocked owner after waiting",
  {
    skip: !process.env.TEST_DATABASE_URL && "Requires disposable PostgreSQL",
    timeout: 30000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.ok(["5432", "55438"].includes(url.port || "5432"));
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_titles_" + suffix,
      admin = await connectDatabase(url.toString());
    const roles = {
      citygo_api: "cgt_api_" + suffix,
      citygo_worker: "cgt_worker_" + suffix,
      citygo_backup: "cgt_backup_" + suffix,
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
    let onOwnerRead = () => {};
    const asRole = <T>(role: string, work: (tx: Sql) => Promise<T>) =>
      db.transaction(async (tx) => {
        await tx.exec(`set local role ${role}`);
        return work({
          exec: (s) => tx.exec(s),
          query: (s, v) => {
            if (s.startsWith("select status,must_change_password"))
              onOwnerRead();
            return tx.query(s, v);
          },
        });
      });
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      asRole(roles.citygo_api, work);
    const runtime: Database = {
      ...db,
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
        "insert into agent_threads(user_id,agent_key,context)values($1,'support',$2::jsonb)returning id::text",
        [owner, JSON.stringify({ preserve: true })],
      )
    ).rows[0]!.id;
    const store = new ConversationTitles(runtime);
    const before = (
      await db.query("select to_jsonb(t)as row from agent_threads t")
    ).rows;
    const race = await Promise.allSettled(
      ["Первый", "Второй"].map((title) =>
        store.update(owner, thread, { title, expectedRevision: "0" }),
      ),
    );
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      race.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof DomainError &&
          r.reason.statusCode === 409,
      ).length,
      1,
    );
    assert.equal((await store.get(owner, thread)).revision, "1");
    await store.update(owner, thread, { title: null, expectedRevision: "1" });
    for (const sql of [
      "delete from conversation_titles",
      "update conversation_titles set user_id=user_id",
      "insert into conversation_titles(thread_id,user_id,title,revision)values(999,1,'x',1)",
    ]) {
      await assert.rejects(
        asApi((tx) => tx.exec(sql)),
        (e: unknown) => (e as { code?: string }).code === "42501",
      );
    }
    await assert.rejects(
      asRole(roles.citygo_worker, (tx) =>
        tx.query("select * from conversation_titles"),
      ),
      (e: unknown) => (e as { code?: string }).code === "42501",
    );
    assert.equal(
      (
        await asRole(roles.citygo_backup, (tx) =>
          tx.query("select * from conversation_titles"),
        )
      ).rows.length,
      1,
    );
    assert.deepEqual(
      (await db.query("select to_jsonb(t)as row from agent_threads t")).rows,
      before,
    );
    let release = () => {},
      written = () => {},
      entered = () => {};
    const gate = new Promise<void>((r) => (release = r)),
      updated = new Promise<void>((r) => (written = r)),
      started = new Promise<void>((r) => (entered = r));
    cleanup.release = release;
    const block = other.transaction(async (tx) => {
      await tx.query("update users set status='blocked'where id=$1", [owner]);
      written();
      await gate;
    });
    await updated;
    onOwnerRead = entered;
    const pending = store.update(owner, thread, {
      title: "must not commit",
      expectedRevision: "2",
    });
    await started;
    release();
    await block;
    await assert.rejects(
      pending,
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
    assert.equal(
      (await db.query("select title from conversation_titles")).rows[0]!.title,
      null,
    );
  },
);

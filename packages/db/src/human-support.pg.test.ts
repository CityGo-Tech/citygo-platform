import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  HumanSupportRequests,
  type Database,
  type Sql,
} from "./index.js";
import { serviceConsentPolicy } from "@citygo/contracts";

test(
  "PostgreSQL support grants, concurrent exact replay and CAS preserve owner/body evidence; Worker cannot read",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires explicitly supplied disposable local PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const base = process.env.TEST_DATABASE_URL!,
      url = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_support_" + suffix,
      roles = {
        citygo_api: "cgs_api_" + suffix,
        citygo_worker: "cgs_worker_" + suffix,
        citygo_backup: "cgs_backup_" + suffix,
      };
    const admin = await connectDatabase(base);
    const cleanup: { backend?: Database } = {};
    let created = false;
    const createdRoles: string[] = [];
    t.after(async () => {
      try {
        if (cleanup.backend) {
          for (const role of createdRoles.reverse())
            await cleanup.backend.exec(
              `drop owned by ${role}; drop role ${role}`,
            );
          await cleanup.backend.close();
        }
        if (created) await admin.exec(`drop database ${name}`);
      } finally {
        await admin.close();
      }
    });
    await admin.exec(`create database ${name} template template0`);
    created = true;
    url.pathname = "/" + name;
    const backend = await connectDatabase(url.toString());
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
        (name) => roles[name as keyof typeof roles],
      );
    await backend.exec(grants);
    const database = backend;
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      database.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        return work(tx);
      });
    const runtime: Database = {
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
      close: async () => {},
    };
    const repo = new Repository(database);
    const user = async (email: string, role = "user") => {
      const userId = await repo.register(email, "synthetic"),
        sessionTokenHash = createHash("sha256")
          .update(randomUUID())
          .digest("hex");
      await repo.createSession(userId, sessionTokenHash);
      await new ServiceConsents(database).choose(userId, {
        policyVersion: serviceConsentPolicy.version,
        personalData: true,
        marketing: false,
      });
      await database.query("update users set role=$2 where id=$1", [
        userId,
        role,
      ]);
      return { userId, sessionTokenHash };
    };
    const owner = await user("pg-support-owner@example.test"),
      operator = await user("pg-support-admin@example.test", "admin"),
      store = new HumanSupportRequests(runtime),
      command = {
        operationId: randomUUID(),
        body: "Нужна помощь человека с первым шагом переезда.",
      };
    const replay = await Promise.all([
      store.create(owner, command),
      store.create(owner, command),
    ]);
    assert.deepEqual(replay[0], replay[1]);
    const id = replay[0]!.request.id;
    assert.equal(
      (await database.query("select * from human_support_requests")).rows
        .length,
      1,
    );
    const race = await Promise.allSettled([
      store.setStatus(operator, id, { expectedRevision: 1, status: "closed" }),
      store.setStatus(operator, id, { expectedRevision: 1, status: "closed" }),
    ]);
    assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(race.filter((r) => r.status === "rejected").length, 1);
    const opened = await store.setStatus(operator, id, {
      expectedRevision: 2,
      status: "open",
    });
    const replyCommand = {
      operationId: randomUUID(),
      expectedRevision: opened.request.revision,
      body: "Проверьте варианты по вашему списку районов.",
    };
    const replied = await Promise.all([
      store.reply(operator, id, replyCommand),
      store.reply(operator, id, replyCommand),
    ]);
    assert.deepEqual(replied[0], replied[1]);
    assert.equal((await store.replies(owner, id)).replies.length, 1);
    const latest = await store.reply(operator, id, {
      operationId: randomUUID(),
      expectedRevision: replied[0]!.request.revision,
      body: "Ещё один ответ поддержки",
    });
    assert.equal((await store.updates(owner)).unreadReplies, 2);
    await Promise.all([
      store.markRead(owner, id, { throughReplyId: latest.reply.id }),
      store.markRead(owner, id, { throughReplyId: replied[0]!.reply.id }),
    ]);
    assert.equal((await store.updates(owner)).unreadReplies, 0);
    assert.equal(
      (
        await database.query<{ through_reply_id: string }>(
          "select through_reply_id::text from human_support_reads where request_id=$1",
          [id],
        )
      ).rows[0]!.through_reply_id,
      latest.reply.id,
    );
    // Owner closure and admin closure serialize on the same current revision.
    const revision = latest.request.revision;
    await assert.rejects(
      store.setOwnStatus(operator, id, {
        expectedRevision: revision,
        status: "closed",
      }),
    );
    const statusRace = await Promise.allSettled([
      store.setOwnStatus(owner, id, {
        expectedRevision: revision,
        status: "closed",
      }),
      store.setStatus(operator, id, {
        expectedRevision: revision,
        status: "closed",
      }),
    ]);
    assert.equal(statusRace.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(statusRace.filter((r) => r.status === "rejected").length, 1);
    const restored = await store.setOwnStatus(owner, id, {
      expectedRevision: revision + 1,
      status: "open",
    });
    assert.equal(restored.request.revision, revision + 2);
    assert.equal(restored.request.body, command.body);
    assert.equal((await store.replies(owner, id)).replies.length, 2);
    assert.equal((await store.updates(owner)).unreadReplies, 0);
    for (const sql of [
      "update human_support_reads set user_id=user_id",
      "update human_support_reads set request_id=request_id",
      "delete from human_support_reads",
    ])
      await assert.rejects(runtime.query(sql), { code: "42501" });
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_worker}`);
        return tx.query("select * from human_support_reads");
      }),
      { code: "42501" },
    );
    await database.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_backup}`);
      assert.equal(
        (await tx.query("select * from human_support_reads")).rows.length,
        1,
      );
    });
    for (const sql of [
      "update human_support_replies set body=body",
      "delete from human_support_replies",
    ])
      await assert.rejects(runtime.query(sql), { code: "42501" });
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_worker}`);
        return tx.query("select body from human_support_replies");
      }),
      { code: "42501" },
    );
    for (const col of [
      "body",
      "user_id",
      "operation_id",
      "request_hash",
      "created_at",
    ])
      await assert.rejects(
        runtime.query(
          `update human_support_requests set ${col}=${col} where id=$1`,
          [id],
        ),
        { code: "42501" },
      );
    await assert.rejects(
      runtime.query("delete from human_support_requests where id=$1", [id]),
      { code: "42501" },
    );
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_worker}`);
        return tx.query("select body from human_support_requests");
      }),
      { code: "42501" },
    );
    await database.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_backup}`);
      assert.equal(
        (await tx.query("select body from human_support_requests")).rows.length,
        1,
      );
    });
    // The queued cursor mutation must recheck account state after acquiring the
    // same security lock as the blocker; a stale HTTP authentication is not enough.
    let started!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => (started = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    const blocker = database.transaction(async (tx) => {
      await tx.query(
        "select id from account_security_state where id=1 for update",
      );
      started();
      await gate;
      await tx.query("update users set status='blocked' where id=$1", [
        owner.userId,
      ]);
    });
    await locked;
    const waiting = store.markRead(owner, id, {
      throughReplyId: latest.reply.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await blocker;
    await assert.rejects(
      waiting,
      (e: unknown) =>
        e instanceof Error && "statusCode" in e && e.statusCode === 401,
    );
    assert.equal(
      (await database.query("select * from human_support_reads")).rows.length,
      1,
    );
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { agentKeys, CITYGO_10X_TARIFF } from "@citygo/contracts";
import {
  connectDatabase,
  ensureConversation,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";

test(
  "PostgreSQL: independent owner locks create unique assistant chats under runtime grants and preserve identity",
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
      "Only disposable loopback PostgreSQL",
    );
    const suffix = randomUUID().replaceAll("-", "");
    const name = "cg_conversations_" + suffix;
    const admin = await connectDatabase(base);
    const cleanup: { db?: Database } = {};
    let created = false;
    const roles = {
      citygo_api: "cgconv_api_" + suffix,
      citygo_worker: "cgconv_worker_" + suffix,
      citygo_backup: "cgconv_backup_" + suffix,
    };
    const createdRoles: string[] = [];
    t.after(async () => {
      try {
        if (cleanup.db) {
          for (const role of createdRoles.reverse())
            await cleanup.db.exec(`drop owned by ${role}; drop role ${role}`);
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
    // Production migrator defaults deny PUBLIC EXECUTE. Trigger enforcement
    // must still work without granting runtime a callable identity-guard API.
    await db.exec(
      "revoke execute on function citygo_guard_assistant_conversation() from public",
    );
    for (const role of Object.values(roles)) {
      await db.exec(
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
    await db.exec(grants);
    const backend = db;
    const asApi = <T>(work: (tx: Sql) => Promise<T>) =>
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_api}`);
        return work(tx);
      });
    const runtime: Database = {
      ...backend,
      query: <T>(sql: string, params?: unknown[]) =>
        asApi((tx) => tx.query<T>(sql, params)),
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
    };
    const repo = new Repository(runtime);
    const owner = await repo.register(
      "pg-conversations@example.test",
      "synthetic",
    );
    const other = await repo.register(
      "pg-conversations-other@example.test",
      "synthetic",
    );
    const raced = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureConversation(runtime, owner, "housing"),
      ),
    );
    assert.equal(new Set(raced.map((thread) => thread.id)).size, 1);
    const pinned = await Promise.all(
      agentKeys.map((key) => ensureConversation(runtime, owner, key)),
    );
    assert.equal(new Set(pinned.map((thread) => thread.id)).size, 5);
    const legacyRace = await Promise.all(
      Array.from({ length: 4 }, () => ensureConversation(runtime, owner)),
    );
    assert.equal(new Set(legacyRace.map((thread) => thread.id)).size, 1);
    assert.ok(!pinned.some((thread) => thread.id === legacyRace[0]!.id));
    const foreign = await ensureConversation(runtime, other, "housing");
    assert.notEqual(foreign.id, raced[0]!.id);
    assert.equal((await repo.conversations(owner)).conversations.length, 6);
    await assert.rejects(repo.conversation(owner, foreign.id), /Чат не найден/);
    await assert.rejects(
      runtime.query(
        "update agent_threads set conversation_agent_key='support',agent_key='support' where id=$1",
        [raced[0]!.id],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      runtime.query(
        "update agent_threads set conversation_agent_key=null where id=$1",
        [raced[0]!.id],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      runtime.query(
        "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'housing','housing')",
        [owner],
      ),
      { code: "23505" },
    );
    await backend.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_worker}`);
      await assert.rejects(
        tx.query(
          "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support')",
          [other],
        ),
        { code: "42501" },
      );
    });
    assert.equal(
      (await backend.query("select * from ai_model_attempts")).rows.length,
      0,
    );
    assert.equal(
      (await backend.query("select * from ai_credit_entries")).rows.length,
      0,
    );
    const policyId = "a".repeat(64);
    await backend.query(
      "insert into ai_routing(id,provider,policy_id,revision)values(1,'routerai',$1,1) on conflict(id)do update set provider='routerai',policy_id=$1,revision=1",
      [policyId],
    );
    await backend.query(
      "insert into ai_consents(user_id,policy_id,granted)values($1,$2,true)",
      [owner, policyId],
    );
    const guarded = new Repository(
      runtime,
      true,
      CITYGO_10X_TARIFF,
      false,
      "fixed5_overdraft",
    );
    const access = {
      policyId,
      revision: 1,
      userDailyLimit: 100,
      globalDailyLimit: 100,
      fixed5CreditReadiness: true,
    };
    const accepted = await Promise.allSettled([
      guarded.reserveChat(
        owner,
        pinned[0]!.id,
        randomUUID(),
        "Synthetic A",
        access,
      ),
      guarded.reserveChat(
        owner,
        pinned[1]!.id,
        randomUUID(),
        "Synthetic B",
        access,
      ),
    ]);
    assert.equal(
      accepted.filter((result) => result.status === "fulfilled").length,
      1,
      "owner lock must serialize different threads before any monetary hold exists",
    );
    assert.equal(
      (await backend.query("select *from chat_requests")).rows.length,
      1,
    );
    assert.equal((await backend.query("select *from messages")).rows.length, 1);
    await assert.rejects(
      guarded.chatRecoveryPreflight(owner, foreign.id, randomUUID()),
      /Чат не найден/,
    );
    await backend.query(
      "update agent_threads set busy_until=clock_timestamp()-interval '1 second'where user_id=$1",
      [owner],
    );
    await guarded.reserveChat(
      owner,
      pinned[1]!.id,
      randomUUID(),
      "Synthetic expired lease",
      access,
    );
    assert.equal(
      (await backend.query("select *from chat_requests")).rows.length,
      2,
    );
  },
);

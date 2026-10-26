import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  PersonalMemory,
  Repository,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";

test(
  "PostgreSQL: actual memory ACL, parallel replay/CAS/capacity, blocked-owner race and erased tombstones",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires an explicitly supplied disposable PostgreSQL",
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
      "Explicit disposable local test target only",
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_memory_" + suffix;
    const admin = await connectDatabase(base),
      roles = {
        citygo_api: "cgmemory_api_" + suffix,
        citygo_worker: "cgmemory_worker_" + suffix,
        citygo_backup: "cgmemory_backup_" + suffix,
      };
    const createdRoles: string[] = [],
      cleanup: { db?: Database } = {};
    let databaseCreated = false;
    t.after(async () => {
      try {
        if (cleanup.db) {
          for (const role of createdRoles.reverse())
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
    const backend = await connectDatabase(url.toString());
    cleanup.db = backend;
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
        (name) => roles[name as keyof typeof roles],
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
      exec: (sql) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
      close: async () => {},
    };
    const owner = await new Repository(backend).register(
        "pg-memory@example.test",
        "synthetic",
      ),
      other = await new Repository(backend).register(
        "pg-memory-other@example.test",
        "synthetic",
      );
    const thread = (
      await backend.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key,status) values($1,'support','closed') returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    const source = (
      await backend.query<{ id: string }>(
        "insert into messages(thread_id,role,content,metadata) values($1,'assistant','Synthetic source','{\"status\":\"complete\"}') returning id::text",
        [thread],
      )
    ).rows[0]!.id;
    const store = new PersonalMemory(runtime),
      input = {
        operationId: randomUUID(),
        sourceMessageId: source,
        label: "Город",
        value: "Москва",
        confirmed: true as const,
      };
    const replay = await Promise.all([
      store.create(owner, input),
      store.create(owner, input),
    ]);
    assert.deepEqual(replay[0], replay[1]);
    const id = replay[0]!.item.id;
    assert.equal(
      (await backend.query("select id from personal_memory_items")).rows.length,
      1,
    );
    const changes = await Promise.allSettled([
      store.update(owner, id, {
        expectedRevision: 1,
        label: "Срок",
        value: "Пока неизвестен",
        confirmed: true,
      }),
      store.update(owner, id, {
        expectedRevision: 1,
        label: "Бюджет",
        value: "Пока не знаю",
        confirmed: true,
      }),
    ]);
    assert.equal(changes.filter((r) => r.status === "fulfilled").length, 1);
    const loser = changes.find((r) => r.status === "rejected");
    assert.ok(
      loser?.status === "rejected" &&
        loser.reason instanceof DomainError &&
        loser.reason.code === "REVISION_CONFLICT" &&
        loser.reason.currentVersion === 2,
    );
    assert.equal((await store.create(owner, input)).item.revision, 2);
    assert.deepEqual((await store.list(other)).items, []);
    await assert.rejects(
      store.remove(other, id, 2),
      (error) => error instanceof DomainError && error.statusCode === 404,
    );
    for (const column of [
      "user_id",
      "source_message_id",
      "operation_id",
      "create_request_hash",
      "created_at",
    ])
      await assert.rejects(
        runtime.query(
          `update personal_memory_items set ${column}=${column} where id=$1`,
          [id],
        ),
        { code: "42501" },
      );
    await assert.rejects(
      runtime.query("delete from personal_memory_items where id=$1", [id]),
      { code: "42501" },
    );
    await backend.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_worker}`);
      await assert.rejects(
        tx.query("select value from personal_memory_items"),
        { code: "42501" },
      );
    });
    await backend.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_backup}`);
      assert.equal(
        (await tx.query("select value from personal_memory_items")).rows.length,
        1,
      );
    });
    let release!: () => void, locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      lockGate = new Promise<void>((resolve) => {
        locked = resolve;
      });
    const blocker = backend.transaction(async (tx) => {
      await tx.query("update users set status='blocked' where id=$1", [owner]);
      locked();
      await releaseGate;
    });
    await lockGate;
    const waiting = store.create(owner, input),
      rejected = assert.rejects(
        waiting,
        (error) => error instanceof DomainError && error.statusCode === 401,
      );
    try {
      const deadline = Date.now() + 5000;
      let sawWait = false;
      while (Date.now() < deadline) {
        const waitingQuery = await backend.query(
          "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select status,must_change_password from users%'",
        );
        if (waitingQuery.rows.length) {
          sawWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(sawWait, true, "Runtime genuinely waited on owner lock");
    } finally {
      release();
      await blocker;
      await rejected;
    }
    assert.deepEqual((await store.list(owner)).items, []);
    await backend.query("update users set status='active' where id=$1", [
      owner,
    ]);
    for (let index = 0; index < 18; index++)
      await store.create(owner, {
        ...input,
        operationId: randomUUID(),
        label: `Synthetic ${index}`,
      });
    const capacity = await Promise.allSettled([
      store.create(owner, {
        ...input,
        operationId: randomUUID(),
        label: "Last A",
      }),
      store.create(owner, {
        ...input,
        operationId: randomUUID(),
        label: "Last B",
      }),
    ]);
    assert.equal(capacity.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      capacity.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof DomainError &&
          r.reason.statusCode === 409,
      ).length,
      1,
    );
    assert.equal((await store.list(owner)).items.length, 20);
    await assert.rejects(
      runtime.query(
        "insert into personal_memory_items(user_id,source_message_id,operation_id,create_request_hash,label,value) values($1,$2,$3,repeat('a',64),'Direct','No')",
        [owner, source, randomUUID()],
      ),
      { code: "23514" },
    );
    await store.remove(owner, id, 2);
    assert.deepEqual(await store.remove(owner, id, 1), {
      userId: owner,
      itemId: id,
      removed: true,
    });
    await assert.rejects(
      store.create(owner, input),
      (error) => error instanceof DomainError && error.statusCode === 409,
    );
    assert.deepEqual(
      (
        await backend.query(
          "select label,value,deleted_at is not null as deleted from personal_memory_items where id=$1",
          [id],
        )
      ).rows,
      [{ label: "", value: "", deleted: true }],
    );
    await store.create(owner, { ...input, operationId: randomUUID() });
    assert.equal((await store.list(owner)).items.length, 20);
    for (const table of [
      "relocation_profiles",
      "relocation_plans",
      "user_quests",
      "xp_events",
      "ai_credit_entries",
      "ai_model_attempts",
      "personal_plan_items",
    ])
      assert.equal(
        (await backend.query(`select 1 from ${table}`)).rows.length,
        0,
        table,
      );
    await backend.query("delete from messages where id=$1", [source]);
    assert.equal(
      (await backend.query("select id from personal_memory_items")).rows.length,
      0,
    );
  },
);

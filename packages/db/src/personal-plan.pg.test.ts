import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  PersonalPlan,
  Repository,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";

test(
  "PostgreSQL: actual API grants, parallel replay/CAS/capacity and tombstones preserve private steps without money or profile writes",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires an explicitly supplied disposable PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const base = process.env.TEST_DATABASE_URL!;
    const url = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
      "Only the explicitly disposable local test database",
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const suffix = randomUUID().replaceAll("-", "");
    const name = "cg_plan_" + suffix;
    const admin = await connectDatabase(base);
    const roles = {
      citygo_api: "cgplan_api_" + suffix,
      citygo_worker: "cgplan_worker_" + suffix,
      citygo_backup: "cgplan_backup_" + suffix,
    };
    const createdRoles: string[] = [];
    const cleanup: { db?: Database } = {};
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
      exec: (sql: string) => asApi((tx) => tx.exec(sql)),
      transaction: asApi,
      close: async () => {},
    };
    const owner = await new Repository(backend).register(
      "pg-plan@example.test",
      "synthetic",
    );
    const other = await new Repository(backend).register(
      "pg-plan-other@example.test",
      "synthetic",
    );
    const thread = (
      await backend.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    const source = (
      await backend.query<{ id: string }>(
        "insert into messages(thread_id,role,content) values($1,'assistant','Synthetic answer') returning id::text",
        [thread],
      )
    ).rows[0]!.id;
    const input = {
      operationId: randomUUID(),
      sourceMessageId: source,
      title: "Сравнить районы",
      details: "Мой выбранный шаг",
    };
    const store = new PersonalPlan(runtime);
    const replay = await Promise.all([
      store.create(owner, input),
      store.create(owner, input),
    ]);
    assert.deepEqual(replay[0], replay[1]);
    const id = replay[0]!.item.id;
    assert.equal(
      (await backend.query("select id from personal_plan_items")).rows.length,
      1,
    );
    const results = await Promise.allSettled([
      store.update(owner, id, {
        expectedRevision: 1,
        title: "Первый выбор",
        details: "",
        status: "completed",
      }),
      store.update(owner, id, {
        expectedRevision: 1,
        title: "Второй выбор",
        details: "",
        status: "pending",
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const loser = results.find((result) => result.status === "rejected");
    assert.ok(
      loser?.status === "rejected" &&
        loser.reason instanceof DomainError &&
        loser.reason.code === "REVISION_CONFLICT" &&
        loser.reason.currentVersion === 2,
    );
    assert.equal((await store.create(owner, input)).item.revision, 2);
    assert.deepEqual((await store.list(other)).items, []);
    const state = (await store.list(owner)).items[0]!;
    assert.deepEqual(await store.summary(owner), {
      userId: owner,
      total: 1,
      pending: state.status === "pending" ? 1 : 0,
      completed: state.status === "completed" ? 1 : 0,
    });
    assert.deepEqual(await store.summary(other), {
      userId: other,
      total: 0,
      pending: 0,
      completed: 0,
    });
    assert.equal(
      (await store.list(owner, undefined, state.status)).items[0]?.id,
      id,
    );
    assert.deepEqual(
      (
        await store.list(
          owner,
          undefined,
          state.status === "pending" ? "completed" : "pending",
        )
      ).items,
      [],
    );
    await assert.rejects(
      store.remove(other, id, 2),
      (error) => error instanceof DomainError && error.statusCode === 404,
    );

    // A request admitted by HTTP before another transaction blocks the owner
    // must recheck the committed account state after waiting for that row.
    let release!: () => void, locked!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockGate = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = backend.transaction(async (tx) => {
      await tx.query("update users set status='blocked' where id=$1", [owner]);
      locked();
      await releaseGate;
    });
    await lockGate;
    const waiting = store.create(owner, input);
    // Attach the rejection handler immediately, before releasing the blocker.
    const rejected = assert.rejects(
      waiting,
      (error) => error instanceof DomainError && error.statusCode === 401,
    );
    try {
      const deadline = Date.now() + 5000;
      let sawWait = false;
      while (Date.now() < deadline) {
        const waitingQuery = await backend.query(`select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'
          and query like 'select status,must_change_password from users%'`);
        if (waitingQuery.rows.length) {
          sawWait = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        sawWait,
        true,
        "The API transaction genuinely waited for the owned user row",
      );
    } finally {
      release();
      await blocker;
      await rejected;
    }
    assert.equal((await store.list(owner)).items.length, 0);
    await backend.query("update users set status='active' where id=$1", [
      owner,
    ]);

    for (const column of [
      "user_id",
      "source_message_id",
      "operation_id",
      "create_request_hash",
      "created_at",
    ])
      await assert.rejects(
        runtime.query(
          `update personal_plan_items set ${column}=${column} where id=$1`,
          [id],
        ),
        { code: "42501" },
      );
    await assert.rejects(
      runtime.query("delete from personal_plan_items where id=$1", [id]),
      { code: "42501" },
    );
    await backend.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_worker}`);
      await assert.rejects(tx.query("select title from personal_plan_items"), {
        code: "42501",
      });
    });
    await backend.transaction(async (tx) => {
      await tx.exec(`set local role ${roles.citygo_backup}`);
      assert.equal(
        (await tx.query("select title from personal_plan_items")).rows.length,
        1,
      );
    });

    await backend.query(
      `insert into personal_plan_items(user_id,source_message_id,operation_id,create_request_hash,title,details)
      select $1,$2,gen_random_uuid(),repeat('a',64),'Synthetic '||n,'' from generate_series(1,198) n`,
      [owner, source],
    );
    const capacity = await Promise.allSettled([
      store.create(owner, {
        ...input,
        operationId: randomUUID(),
        title: "Последнее место A",
      }),
      store.create(owner, {
        ...input,
        operationId: randomUUID(),
        title: "Последнее место B",
      }),
    ]);
    assert.equal(
      capacity.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      capacity.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof DomainError &&
          result.reason.statusCode === 409,
      ).length,
      1,
    );
    assert.equal(
      (
        await backend.query<{ count: number }>(
          "select count(*)::integer as count from personal_plan_items where deleted_at is null",
        )
      ).rows[0]!.count,
      200,
    );
    assert.equal((await store.create(owner, input)).item.id, id);
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
    const replacement = await store.create(owner, {
      ...input,
      operationId: randomUUID(),
    });
    assert.notEqual(replacement.item.id, id);
    assert.equal(
      (
        await backend.query<{ count: number }>(
          "select count(*)::integer as count from personal_plan_items where deleted_at is null",
        )
      ).rows[0]!.count,
      200,
    );
    for (const table of [
      "relocation_profiles",
      "relocation_plans",
      "user_quests",
      "xp_events",
      "ai_credit_entries",
      "ai_model_attempts",
    ])
      assert.equal(
        (await backend.query(`select 1 from ${table}`)).rows.length,
        0,
        table,
      );
    // A separate owner has capacity for a truly source-less row under actual API grants.
    const manualCommand = {
      ...input,
      operationId: randomUUID(),
      sourceMessageId: null,
    };
    const manualReplay = await Promise.all([
      store.create(other, manualCommand),
      store.create(other, manualCommand),
    ]);
    assert.deepEqual(manualReplay[0], manualReplay[1]);
    assert.equal(manualReplay[0]!.item.source, null);
    await store.update(other, manualReplay[0]!.item.id, {
      expectedRevision: 1,
      title: "Собственный шаг",
      details: "",
      status: "completed",
    });
    assert.equal((await store.list(other)).items[0]?.source, null);
    await backend.query("delete from messages where id=$1", [source]);
    assert.equal(
      (await backend.query("select id from personal_plan_items")).rows.length,
      1,
    );
    assert.equal(
      (await store.list(other)).items[0]?.id,
      manualReplay[0]!.item.id,
    );
  },
);

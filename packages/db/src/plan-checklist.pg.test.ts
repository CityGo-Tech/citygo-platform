import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  PersonalPlan,
  PlanChecklists,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
test(
  "PostgreSQL checklist runtime grants and parallel parent CAS preserve one explicit winner and deny Worker access",
  {
    skip:
      !process.env.TEST_DATABASE_URL &&
      "Requires an explicitly disposable local PostgreSQL",
    timeout: 60000,
  },
  async (t) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.ok(
      ((url.port || "5432") === "5432" && url.pathname === "/citygo_test") ||
        (url.port === "55438" && url.pathname === "/citygo_synthetic"),
    );
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
    const suffix = randomUUID().replaceAll("-", ""),
      name = "cg_checklist_" + suffix,
      roles = {
        citygo_api: "cgcl_api_" + suffix,
        citygo_worker: "cgcl_worker_" + suffix,
        citygo_backup: "cgcl_backup_" + suffix,
      };
    const admin = await connectDatabase(url.toString());
    const cleanup: { db?: Database } = {};
    let created = false;
    const createdRoles: string[] = [];
    t.after(async () => {
      try {
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
    const backend = await connectDatabase(url.toString());
    cleanup.db = backend;
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
      "pg-checklist@example.test",
      "synthetic",
    );
    const item = (
      await new PersonalPlan(runtime).create(owner, {
        operationId: randomUUID(),
        sourceMessageId: null,
        title: "Private manual step",
        details: "",
      })
    ).item;
    const store = new PlanChecklists(runtime),
      entry = {
        id: randomUUID(),
        title: "Check payment",
        details: "Synthetic",
        completed: false,
      };
    const races = await Promise.allSettled([
      store.save(owner, item.id, { expectedRevision: 1, entries: [entry] }),
      store.save(owner, item.id, {
        expectedRevision: 1,
        entries: [{ ...entry, completed: true }],
      }),
    ]);
    assert.equal(
      races.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = races.find((result) => result.status === "rejected");
    assert.ok(
      rejected?.status === "rejected" &&
        rejected.reason instanceof DomainError &&
        rejected.reason.statusCode === 409,
    );
    assert.equal((await store.get(owner, item.id)).revision, 2);
    assert.equal(
      (await new PersonalPlan(runtime).list(owner)).items[0]!.status,
      "pending",
    );
    await assert.rejects(
      backend.transaction(async (tx) => {
        await tx.exec(`set local role ${roles.citygo_worker}`);
        return tx.query("select * from personal_plan_checklists");
      }),
    );
    await assert.rejects(
      asApi((tx) =>
        tx.query("delete from personal_plan_checklists where item_id=$1", [
          item.id,
        ]),
      ),
    );
    await assert.rejects(
      asApi((tx) =>
        tx.query(
          "update personal_plan_checklists set entries='[]'::jsonb where item_id=$1",
          [item.id],
        ),
      ),
    );
    assert.equal(
      (await backend.query("select * from ai_credit_entries")).rows.length,
      0,
    );
    assert.equal(
      (await backend.query("select * from xp_events")).rows.length,
      0,
    );
  },
);

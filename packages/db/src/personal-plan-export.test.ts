import type { PersonalPlanItem } from "@citygo/contracts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  PersonalPlan,
  PlanChecklists,
  exportPersonalPlan,
  DomainError,
  type Database,
} from "./index.js";

test("whole plan snapshot includes every owned page and checklist without text sources, tombstones or writes", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    owner = await repo.register("export-owner@example.test", "synthetic"),
    other = await repo.register("export-other@example.test", "synthetic");
  const store = new PersonalPlan(db),
    checklists = new PlanChecklists(db);
  const created: PersonalPlanItem[] = [];
  for (let n = 0; n < 24; n++)
    created.push(
      (
        await store.create(owner, {
          operationId: randomUUID(),
          sourceMessageId: null,
          title: "Шаг " + n,
          details: "Описание " + n,
        })
      ).item,
    );
  const first = created[0]!;
  await checklists.save(owner, first.id, {
    expectedRevision: 1,
    entries: [
      {
        id: randomUUID(),
        title: "Готовый пункт",
        details: "Весь текст",
        completed: true,
      },
      { id: randomUUID(), title: "Ещё пункт", details: "", completed: false },
    ],
  });
  await store.update(owner, first.id, {
    expectedRevision: 2,
    title: first.title,
    details: first.details,
    status: "completed",
  });
  await store.remove(owner, created[1]!.id, 1);
  await store.create(other, {
    operationId: randomUUID(),
    sourceMessageId: null,
    title: "ЧУЖОЙ_ШАГ",
    details: "",
  });
  const before = (
    await db.query(
      "select row_to_json(p)::text as row from personal_plan_items p order by id",
    )
  ).rows;
  const queries: string[] = [];
  const guarded: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: async () => {
            throw new Error("Export must not execute writes");
          },
          query: (sql, values) => {
            queries.push(sql);
            assert.match(sql, /^with owner/);
            return tx.query(sql, values);
          },
        }),
      ),
  };
  const value = await exportPersonalPlan(guarded, owner);
  assert.equal(queries.length, 1);
  assert.equal(value.userId, owner);
  assert.equal(value.items.length, 23);
  assert.equal(value.items[0]!.id, created.at(-1)!.id);
  assert.equal(
    value.items.some((x) => x.id === created[1]!.id),
    false,
  );
  assert.equal(
    value.items.some((x) => x.title === "ЧУЖОЙ_ШАГ"),
    false,
  );
  assert.equal(value.items.at(-1)!.status, "completed");
  assert.deepEqual(
    value.items.at(-1)!.checklist.map((x) => x.completed),
    [true, false],
  );
  assert.equal(value.items.at(-1)!.checklist[0]!.details, "Весь текст");
  assert.deepEqual(
    (
      await db.query(
        "select row_to_json(p)::text as row from personal_plan_items p order by id",
      )
    ).rows,
    before,
  );
  assert.deepEqual(
    (await exportPersonalPlan(db, other)).items.map((x) => x.title),
    ["ЧУЖОЙ_ШАГ"],
  );
  await db.query("update users set status='blocked' where id=$1", [owner]);
  await assert.rejects(
    exportPersonalPlan(db, owner),
    (e) => e instanceof DomainError && e.statusCode === 403,
  );
});

test("empty plan exports an empty real snapshot; invalid stored output never becomes a partial export", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "empty-export@example.test",
    "synthetic",
  );
  assert.deepEqual((await exportPersonalPlan(db, owner)).items, []);
  const broken: Database = {
    ...db,
    transaction: (work) =>
      work({
        exec: db.exec,
        query: async <T>() => ({
          rows: [
            {
              generatedAt: "2026-10-31T12:00:00Z",
              items: [{ private: "never expose" }],
            },
          ] as T[],
        }),
      }),
  };
  await assert.rejects(
    exportPersonalPlan(broken, owner),
    (e) =>
      e instanceof DomainError &&
      e.statusCode === 500 &&
      !e.message.includes("private"),
  );
});

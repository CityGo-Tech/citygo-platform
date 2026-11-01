import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  connectDatabase,
  Repository,
  PersonalPlan,
  PersonalPlanHistory,
} from "./index.js";
import { applyFixtureMigration } from "./test-service-consents.js";
import { seedLegacyPlan } from "./test-legacy-personal-plan.js";
test("schema40→41 records only the actual surviving state, never fabricates earlier revisions or changes rows", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (name) =>
        name.endsWith(".sql") && name < "0041_personal_plan_history.sql",
    )
    .sort())
    await applyFixtureMigration(db, name);
  const owner = await new Repository(db).register(
    "history-upgrade@example.test",
    "synthetic",
  );
  const item = (
    await seedLegacyPlan(db, owner, {
      operationId: randomUUID(),
      sourceMessageId: null,
      title: "Последнее реальное название",
      details: "Точные\nбайты",
    })
  ).item;
  const removed = (
    await seedLegacyPlan(db, owner, {
      operationId: randomUUID(),
      sourceMessageId: null,
      title: "Удалённый шаг",
      details: "Не показывать",
    })
  ).item;
  await new PersonalPlan(db).remove(owner, removed.id, 1);
  await db.query(
    "update personal_plan_items set revision=revision+1,status='completed',updated_at=clock_timestamp() where id=$1",
    [item.id],
  );
  const checks = [
    {
      id: randomUUID(),
      title: "Пункт",
      details: "Точная деталь",
      completed: true,
    },
  ];
  await db.query(
    "insert into personal_plan_checklists(item_id,parent_revision,entries) values($1,2,$2::jsonb)",
    [item.id, JSON.stringify(checks)],
  );
  const before = (
    await db.query(
      "select to_jsonb(p) as row from personal_plan_items p order by id",
    )
  ).rows;
  await applyFixtureMigration(db, "0041_personal_plan_history.sql");
  await applyFixtureMigration(db, "0041_personal_plan_history.sql");
  assert.deepEqual(
    (
      await db.query(
        "select to_jsonb(p) as row from personal_plan_items p order by id",
      )
    ).rows,
    before,
  );
  const history = await new PersonalPlanHistory(db).page(owner, item.id);
  assert.equal(history.entries.length, 1);
  assert.equal(history.currentRevision, 2);
  assert.deepEqual(
    { ...history.entries[0], recordedAt: null },
    {
      revision: 2,
      title: item.title,
      details: item.details,
      status: "completed",
      checklist: checks,
      initialSnapshot: true,
      recordedAt: null,
    },
  );
  assert.equal(
    (
      await db.query(
        "select * from personal_plan_item_history where item_id=$1",
        [removed.id],
      )
    ).rows.length,
    0,
  );
  await new PersonalPlan(db).update(owner, item.id, {
    expectedRevision: 2,
    title: "Новый шаг",
    details: "",
    status: "pending",
  });
  assert.deepEqual(
    (await new PersonalPlanHistory(db).page(owner, item.id)).entries.map(
      (row) => [row.revision, row.initialSnapshot],
    ),
    [
      [3, false],
      [2, true],
    ],
  );
});

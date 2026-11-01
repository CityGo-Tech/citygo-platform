import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  connectDatabase,
  Repository,
  PersonalPlan,
  PlanChecklists,
} from "./index.js";
import { applyFixtureMigration } from "./test-service-consents.js";
import { seedLegacyPlan } from "./test-legacy-personal-plan.js";
test("schema38 to39 preserves sourced and manual step bytes and creates no automatic checklist", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await db.exec(
    "create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter(
      (name) => name.endsWith(".sql") && name < "0039_plan_checklists.sql",
    )
    .sort())
    await applyFixtureMigration(db, name);
  const owner = await new Repository(db).register(
    "checklist-upgrade@example.test",
    "synthetic",
  );
  const plan = new PersonalPlan(db),
    item = (
      await seedLegacyPlan(db, owner, {
        operationId: randomUUID(),
        sourceMessageId: null,
        title: "Мой шаг",
        details: "Сохранить",
      })
    ).item;
  const before = (
    await db.query("select to_jsonb(p) as row from personal_plan_items p")
  ).rows;
  await applyFixtureMigration(db, "0039_plan_checklists.sql");
  assert.deepEqual(
    (await db.query("select to_jsonb(p) as row from personal_plan_items p"))
      .rows,
    before,
  );
  assert.equal(
    (await db.query("select * from personal_plan_checklists")).rows.length,
    0,
  );
  assert.deepEqual(await new PlanChecklists(db).get(owner, item.id), {
    userId: owner,
    itemId: item.id,
    revision: 1,
    entries: [],
  });
  await applyFixtureMigration(db, "0039_plan_checklists.sql");
  assert.deepEqual((await plan.list(owner)).items, [item]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  PersonalPlan,
  PersonalPlanHistory,
  PlanChecklists,
  DomainError,
  type Database,
} from "./index.js";
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
test("restoring a private saved version appends its exact state once, preserves source/money/history, and rolls back a failed history write", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    owner = await repo.register("restore@example.test", "synthetic"),
    other = await repo.register("restore-other@example.test", "synthetic");
  const plan = new PersonalPlan(db),
    history = new PersonalPlanHistory(db),
    checks = new PlanChecklists(db);
  const item = (
    await plan.create(owner, {
      operationId: randomUUID(),
      sourceMessageId: null,
      title: "Первая версия",
      details: "Точные\nподробности",
    })
  ).item;
  const entries = [
    {
      id: randomUUID(),
      title: "Старый пункт",
      details: "Точная деталь",
      completed: true,
    },
  ];
  await checks.save(owner, item.id, { expectedRevision: 1, entries });
  await plan.update(owner, item.id, {
    expectedRevision: 2,
    title: "Изменённый шаг",
    details: "Новый текст",
    status: "completed",
  });
  await checks.save(owner, item.id, { expectedRevision: 3, entries: [] });
  const before = (
    await db.query("select * from personal_plan_item_history order by revision")
  ).rows;
  const original = (
    await db.query(
      "select source_message_id,created_at,create_request_hash,operation_id from personal_plan_items where id=$1",
      [item.id],
    )
  ).rows[0];
  const protectedRows = async () =>
    JSON.stringify(
      (
        await db.query(
          "select (select json_agg(t)from ai_credit_accounts t)as credits,(select json_agg(t)from payment_topup_orders t)as payments,(select json_agg(t)from xp_events t)as xp,(select json_agg(t)from phone_welcome_claims t)as gifts",
        )
      ).rows,
    );
  const protectedBefore = await protectedRows();
  const restored = await history.restore(owner, item.id, {
    expectedRevision: 4,
    revision: 2,
  });
  assert.equal(restored.entry.revision, 5);
  assert.equal(restored.restoredRevision, 2);
  assert.equal(restored.entry.title, item.title);
  assert.equal(restored.entry.details, item.details);
  assert.equal(restored.entry.status, "pending");
  assert.deepEqual(restored.entry.checklist, entries);
  assert.equal(restored.entry.initialSnapshot, false);
  assert.deepEqual((await checks.get(owner, item.id)).entries, entries);
  assert.deepEqual(
    (
      await db.query(
        "select * from personal_plan_item_history where revision<=4 order by revision",
      )
    ).rows,
    before,
  );
  assert.deepEqual(
    (
      await db.query(
        "select source_message_id,created_at,create_request_hash,operation_id from personal_plan_items where id=$1",
        [item.id],
      )
    ).rows[0],
    original,
  );
  await assert.rejects(
    history.restore(owner, item.id, { expectedRevision: 4, revision: 2 }),
    status(409),
  );
  await assert.rejects(
    history.restore(other, item.id, { expectedRevision: 5, revision: 2 }),
    status(404),
  );
  assert.equal((await history.page(owner, item.id)).currentRevision, 5);
  const stable = JSON.stringify(
    (await db.query("select * from personal_plan_items")).rows,
  );
  const broken: Database = {
    query: db.query.bind(db),
    exec: db.exec.bind(db),
    close: async () => {},
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          exec: tx.exec.bind(tx),
          query: (sql, values) => {
            if (sql.includes("insert into personal_plan_item_history"))
              throw new Error("synthetic history failure");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  await assert.rejects(
    new PersonalPlanHistory(broken).restore(owner, item.id, {
      expectedRevision: 5,
      revision: 1,
    }),
    /synthetic history failure/,
  );
  assert.equal(
    JSON.stringify((await db.query("select * from personal_plan_items")).rows),
    stable,
  );
  assert.deepEqual((await checks.get(owner, item.id)).entries, entries);
  assert.equal(await protectedRows(), protectedBefore);
  for (const [assignment, code] of [
    ["status='blocked'", 401],
    ["must_change_password=true", 403],
  ] as const) {
    await db.query("update users set " + assignment + " where id=$1", [owner]);
    await assert.rejects(
      history.restore(owner, item.id, { expectedRevision: 5, revision: 1 }),
      status(code),
    );
    await db.query(
      "update users set status='active',must_change_password=false where id=$1",
      [owner],
    );
  }
  await plan.remove(owner, item.id, 5);
  await assert.rejects(
    history.restore(owner, item.id, { expectedRevision: 6, revision: 1 }),
    status(404),
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  PersonalPlan,
  PlanChecklists,
  DomainError,
  ClosedAccountRestart,
  FreshAccountReset,
} from "./index.js";
test("private checklist CAS persists exact bounded entries without completing the step or touching money, messages or XP", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    plan = new PersonalPlan(db),
    store = new PlanChecklists(db);
  const owner = await repo.register("checklist@example.test", "synthetic"),
    other = await repo.register("other-checklist@example.test", "synthetic");
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const message = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content) values($1,'user','Source') returning id::text",
      [thread],
    )
  ).rows[0]!.id;
  const item = (
    await plan.create(owner, {
      operationId: randomUUID(),
      sourceMessageId: message,
      title: "Подготовка к просмотру",
      details: "Мой шаг",
    })
  ).item;
  const entries = [
    {
      id: randomUUID(),
      title: "Платежи",
      details: "Уточнить все платежи 🏠",
      completed: false,
    },
  ];
  const stable = async () => ({
    messages: (await db.query("select * from messages")).rows,
    xp: (await db.query("select * from xp_events")).rows,
    money: (await db.query("select * from ai_credit_entries")).rows,
  });
  const before = await stable();
  assert.deepEqual(await store.get(owner, item.id), {
    userId: owner,
    itemId: item.id,
    revision: 1,
    entries: [],
  });
  const saved = await store.save(owner, item.id, {
    expectedRevision: 1,
    entries,
  });
  assert.deepEqual(saved.entries, entries);
  assert.equal(saved.revision, 2);
  await assert.rejects(
    store.get(other, item.id),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  await assert.rejects(
    store.save(other, item.id, { expectedRevision: 2, entries }),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  await assert.rejects(
    store.save(owner, item.id, { expectedRevision: 1, entries }),
    (e) => e instanceof DomainError && e.statusCode === 409,
  );
  const toggled = await store.save(owner, item.id, {
    expectedRevision: 2,
    entries: [{ ...entries[0]!, completed: true }],
  });
  assert.equal(toggled.revision, 3);
  assert.equal((await plan.list(owner)).items[0]!.status, "pending");
  await plan.update(owner, item.id, {
    expectedRevision: 3,
    title: item.title,
    details: item.details,
    status: "pending",
  });
  assert.equal((await store.get(owner, item.id)).revision, 4);
  await assert.rejects(
    store.save(owner, item.id, { expectedRevision: 3, entries }),
    (e) => e instanceof DomainError && e.statusCode === 409,
  );
  await assert.rejects(
    db.query(
      "update personal_plan_checklists set entries=$2::jsonb where item_id=$1",
      [item.id, JSON.stringify([])],
    ),
  );
  assert.equal(
    (
      await db.query("select citygo_valid_plan_checklist($1::jsonb) as valid", [
        JSON.stringify([null]),
      ])
    ).rows[0]!.valid,
    false,
  );
  assert.deepEqual(await stable(), before);
  await plan.remove(owner, item.id, 4);
  await assert.rejects(
    store.get(owner, item.id),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  await assert.rejects(
    store.save(owner, item.id, { expectedRevision: 4, entries: [] }),
    (e) => e instanceof DomainError && e.statusCode === 404,
  );
  assert.equal(
    (await db.query("select entries from personal_plan_checklists")).rows
      .length,
    1,
  );
});

test("sourced checklist follows the existing source deletion cascade while an ordinary soft removal retains it", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "checklist-cascade@example.test",
    "synthetic",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const message = (
    await db.query<{ id: string }>(
      "insert into messages(thread_id,role,content) values($1,'user','Synthetic') returning id::text",
      [thread],
    )
  ).rows[0]!.id;
  const item = (
    await new PersonalPlan(db).create(owner, {
      operationId: randomUUID(),
      sourceMessageId: message,
      title: "Сохранить",
      details: "",
    })
  ).item;
  await new PlanChecklists(db).save(owner, item.id, {
    expectedRevision: 1,
    entries: [
      { id: randomUUID(), title: "Пункт", details: "", completed: false },
    ],
  });
  await db.query("delete from messages where id=$1", [message]);
  assert.equal(
    (await db.query("select * from personal_plan_items")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select * from personal_plan_checklists")).rows.length,
    0,
  );
});

test("maintenance inventories retain checklist contents and refuse clearing a step with retained checklist history", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const owner = await new Repository(db).register(
    "checklist-retained@example.test",
    "synthetic",
  );
  const plan = new PersonalPlan(db),
    item = (
      await plan.create(owner, {
        operationId: randomUUID(),
        sourceMessageId: null,
        title: "Мой шаг",
        details: "",
      })
    ).item;
  await new PlanChecklists(db).save(owner, item.id, {
    expectedRevision: 1,
    entries: [
      {
        id: randomUUID(),
        title: "PRIVATE-CHECKLIST",
        details: "PRIVATE-DETAILS",
        completed: false,
      },
    ],
  });
  await plan.remove(owner, item.id, 2);
  const before = (await db.query("select * from personal_plan_checklists"))
    .rows;
  for (const tool of [
    new ClosedAccountRestart(db),
    new FreshAccountReset(db),
  ]) {
    const inspected = await tool.plan({
      expectedUserCount: 1,
      maintenanceConfirmed: true,
    });
    assert.equal(inspected.counts.personal_plan_checklists, 1);
    assert.ok(
      inspected.blockers.some(
        (value) => value.code === "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW",
      ),
    );
    assert.equal(
      JSON.stringify(inspected).includes("PRIVATE-CHECKLIST"),
      false,
    );
    assert.deepEqual(
      (await db.query("select * from personal_plan_checklists")).rows,
      before,
    );
  }
});

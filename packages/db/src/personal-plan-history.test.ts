import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
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
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    owner = await repo.register("history@example.test", "synthetic"),
    other = await repo.register("other-history@example.test", "synthetic");
  const plan = new PersonalPlan(db),
    history = new PersonalPlanHistory(db);
  const input = {
    operationId: randomUUID(),
    sourceMessageId: null,
    title: "Первое название",
    details: "Исходная запись",
  };
  const item = (await plan.create(owner, input)).item;
  return { db, owner, other, plan, history, input, item };
}
const status = (code: number) => (error: unknown) =>
  error instanceof DomainError && error.statusCode === code;
test("saved history captures exact title, body, status and checklist atomically, without replay or CAS duplicates", async (t) => {
  const f = await fixture(t);
  const checks = [
    {
      id: randomUUID(),
      title: "Проверить карту",
      details: "Личная деталь",
      completed: true,
    },
  ];
  await new PlanChecklists(f.db).save(f.owner, f.item.id, {
    expectedRevision: 1,
    entries: checks,
  });
  const latest = (
    await f.plan.update(f.owner, f.item.id, {
      expectedRevision: 2,
      title: "Новое название",
      details: "Новая запись",
      status: "completed",
    })
  ).item;
  assert.equal((await f.plan.create(f.owner, f.input)).item.revision, 3);
  await assert.rejects(
    f.plan.update(f.owner, f.item.id, {
      expectedRevision: 2,
      title: "Stale",
      details: "",
      status: "pending",
    }),
    status(409),
  );
  const page = await f.history.page(f.owner, f.item.id);
  assert.deepEqual(
    page.entries.map((entry) => [
      entry.revision,
      entry.title,
      entry.details,
      entry.status,
      entry.checklist,
    ]),
    [
      [3, latest.title, latest.details, "completed", checks],
      [2, f.item.title, f.item.details, "pending", checks],
      [1, f.item.title, f.item.details, "pending", []],
    ],
  );
  assert.equal(
    page.entries.every((entry) => !entry.initialSnapshot),
    true,
  );
  const prior = JSON.stringify((await f.plan.list(f.owner)).items);
  const broken: Database = {
    ...f.db,
    query: f.db.query.bind(f.db),
    exec: f.db.exec.bind(f.db),
    close: async () => {},
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          ...tx,
          exec: tx.exec.bind(tx),
          query: (sql, values) => {
            if (sql.includes("insert into personal_plan_item_history"))
              throw new Error("synthetic append failure");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  await assert.rejects(
    new PersonalPlan(broken).update(f.owner, f.item.id, {
      expectedRevision: 3,
      title: "Must rollback",
      details: "",
      status: "pending",
    }),
    /synthetic append/,
  );
  assert.equal(JSON.stringify((await f.plan.list(f.owner)).items), prior);
  assert.equal((await f.history.page(f.owner, f.item.id)).entries.length, 3);
  await assert.rejects(
    new PlanChecklists(broken).save(f.owner, f.item.id, {
      expectedRevision: 3,
      entries: [],
    }),
    /synthetic append/,
  );
  assert.deepEqual(
    (await new PlanChecklists(f.db).get(f.owner, f.item.id)).entries,
    checks,
  );
  assert.equal(JSON.stringify((await f.plan.list(f.owner)).items), prior);
  const command = {
    ...f.input,
    operationId: randomUUID(),
    title: "Rollback create",
  };
  await assert.rejects(
    new PersonalPlan(broken).create(f.owner, command),
    /synthetic append/,
  );
  assert.equal((await f.plan.list(f.owner)).items.length, 1);
  const retried = await f.plan.create(f.owner, command);
  assert.equal(
    (await f.history.page(f.owner, retried.item.id)).entries.length,
    1,
  );
});
test("history is private, fails closed for blocked/password accounts, and tombstones make every retained version inaccessible", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.history.page(f.other, f.item.id), status(404));
  for (const assignment of ["status='blocked'", "must_change_password=true"]) {
    await f.db.query("update users set " + assignment + " where id=$1", [
      f.owner,
    ]);
    await assert.rejects(
      f.history.page(f.owner, f.item.id),
      status(assignment.includes("status") ? 401 : 403),
    );
    await f.db.query(
      "update users set status='active',must_change_password=false where id=$1",
      [f.owner],
    );
  }
  await assert.rejects(
    f.db.query(
      "update personal_plan_item_history set title='changed' where item_id=$1",
      [f.item.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    f.db.query(
      "insert into personal_plan_item_history(item_id,revision,title,details,status,checklist) values($1,2,'Forged','','pending','[]')",
      [f.item.id],
    ),
    { code: "23514" },
  );
  await f.plan.remove(f.owner, f.item.id, 1);
  await assert.rejects(f.history.page(f.owner, f.item.id), status(404));
  await assert.rejects(f.history.page(f.owner, f.item.id, 2), status(404));
  assert.equal(
    (
      await f.db.query(
        "select title from personal_plan_item_history where item_id=$1",
        [f.item.id],
      )
    ).rows.length,
    1,
    "Existing soft-delete retention is explicit, never exposed as live history",
  );
});
test("history uses safe revision cursors and bigint IDs with bounded UTF-8 pages", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "select setval('personal_plan_items_id_seq',9007199254740992,true)",
  );
  const item = (
    await f.plan.create(f.owner, { ...f.input, operationId: randomUUID() })
  ).item;
  assert.ok(BigInt(item.id) > BigInt(Number.MAX_SAFE_INTEGER));
  const entries = Array.from({ length: 20 }, (_, i) => ({
    id: randomUUID(),
    title: "漢".repeat(120),
    details: "漢".repeat(1000),
    completed: i % 2 === 0,
  }));
  let revision = 1;
  for (let i = 0; i < 8; i++) {
    await new PlanChecklists(f.db).save(f.owner, item.id, {
      expectedRevision: revision++,
      entries,
    });
  }
  const first = await f.history.page(f.owner, item.id);
  assert.ok(Buffer.byteLength(JSON.stringify(first.entries)) <= 256 * 1024);
  assert.ok(first.entries.length < 5);
  assert.ok(first.nextBefore);
  let page = first;
  const seen = [...page.entries.map((entry) => entry.revision)];
  while (page.nextBefore) {
    page = await f.history.page(f.owner, item.id, page.nextBefore);
    seen.push(...page.entries.map((entry) => entry.revision));
  }
  assert.deepEqual(seen, [9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual((await f.history.page(f.owner, item.id, 1)).entries, []);
  await assert.rejects(
    f.history.page(f.owner, item.id, Number.MAX_SAFE_INTEGER + 1),
    status(400),
  );
});

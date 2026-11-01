import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AccountReset,
  ClosedAccountRestart,
  connectDatabase,
  DomainError,
  FreshAccountReset,
  migrate,
  PersonalPlan,
  Repository,
} from "./index.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";

for (const removed of [false, true]) {
  test(`maintenance refuses ${removed ? "a retained tombstone" : "an active private step"} without changing any account, plan or accounting row`, async (t) => {
    const db = await connectDatabase("pglite://:memory:");
    t.after(() => db.close());
    await migrate(db);
    const repo = new Repository(db),
      plan = new PersonalPlan(db);
    const owner = await repo.register(
      "plan-maintenance@example.test",
      "synthetic",
    );
    await repo.register("plan-maintenance-other@example.test", "synthetic");
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    const source = (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content) values($1,'user','PRIVATE-PLAN-SOURCE') returning id::text",
        [thread],
      )
    ).rows[0]!.id;
    const item = await plan.create(owner, {
      operationId: randomUUID(),
      sourceMessageId: source,
      title: "PRIVATE-PLAN-TITLE",
      details: "PRIVATE-PLAN-DETAILS",
    });
    if (removed) await plan.remove(owner, item.item.id, item.item.revision);
    const before = await captureRestartRows(db);
    const sequences = (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows;
    const options = {
      expectedUserCount: 2,
      maintenanceConfirmed: true as const,
    };
    const inventory = await new AccountReset(db).plan(options);
    assert.equal(inventory.counts.personal_plan_items, 1);
    assert.equal(inventory.counts.personal_plan_item_history, 1);
    assert.ok(inventory.retained.includes("personal_plan_item_history"));
    assert.deepEqual(
      inventory.blockers.find(
        (blocker) => blocker.code === "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW",
      ),
      {
        code: "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW",
        count: 2,
      },
    );
    assert.doesNotMatch(
      JSON.stringify(inventory),
      /PRIVATE-PLAN|@example\.test/,
    );
    assert.deepEqual(await captureRestartRows(db), before);
    for (const mode of ["closed", "fresh"] as const) {
      const reset =
        mode === "closed"
          ? new ClosedAccountRestart(db)
          : new FreshAccountReset(db);
      const inspected = await reset.plan(options);
      assert.equal(inspected.counts.personal_plan_items, 1);
      assert.equal(inspected.counts.personal_plan_item_history, 1);
      if ("retained" in inspected)
        assert.ok(inspected.retained.includes("personal_plan_item_history"));
      if ("preservedTables" in inspected)
        assert.equal(
          inspected.erasedTables.includes("personal_plan_item_history"),
          false,
        );
      assert.deepEqual(
        inspected.blockers.find(
          (blocker) => blocker.code === "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW",
        ),
        { code: "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW", count: 2 },
        "Both the retained step and its exact saved revision require review",
      );
      assert.equal(
        /PRIVATE-PLAN|@example\.test/.test(JSON.stringify(inspected)),
        false,
      );
      const common = {
        ...options,
        expectedSnapshotFingerprint: inspected.snapshotFingerprint,
        backupReceiptSha256: "b".repeat(64),
        servicesStoppedConfirmed: true as const,
        passwordHash: "synthetic-bootstrap-hash",
      };
      const attempt =
        mode === "closed"
          ? (reset as ClosedAccountRestart).apply({
              ...common,
              retainedAuditsReviewed: true,
            })
          : (reset as FreshAccountReset).apply({
              ...common,
              destructiveResetConfirmed: true,
            });
      await assert.rejects(
        attempt,
        (error) => error instanceof DomainError && error.statusCode === 409,
      );
      assert.deepEqual(await captureRestartRows(db), before, mode);
      assert.deepEqual(
        (
          await db.query(
            "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
          )
        ).rows,
        sequences,
        mode,
      );
    }
    assert.equal((await plan.list(owner)).items.length, removed ? 0 : 1);
  });
}

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
  PersonalMemory,
  Repository,
} from "./index.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";

for (const removed of [false, true]) {
  test(`maintenance refuses ${removed ? "a retained tombstone" : "an active confirmed fact"} without changing any account, memory or accounting row`, async (t) => {
    const db = await connectDatabase("pglite://:memory:");
    t.after(() => db.close());
    await migrate(db);
    const repo = new Repository(db),
      plan = new PersonalMemory(db);
    const owner = await repo.register(
      "memory-maintenance@example.test",
      "synthetic",
    );
    await repo.register("memory-maintenance-other@example.test", "synthetic");
    const thread = (
      await db.query<{ id: string }>(
        "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
        [owner],
      )
    ).rows[0]!.id;
    const source = (
      await db.query<{ id: string }>(
        "insert into messages(thread_id,role,content) values($1,'user','PRIVATE-MEMORY-SOURCE') returning id::text",
        [thread],
      )
    ).rows[0]!.id;
    const item = await plan.create(owner, {
      operationId: randomUUID(),
      sourceMessageId: source,
      label: "PRIVATE-MEMORY-TITLE",
      value: "PRIVATE-MEMORY-DETAILS",
      confirmed: true,
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
    assert.equal(inventory.counts.personal_memory_items, 1);
    for (const mode of ["closed", "fresh"] as const) {
      const reset =
        mode === "closed"
          ? new ClosedAccountRestart(db)
          : new FreshAccountReset(db);
      const inspected = await reset.plan(options);
      assert.equal(inspected.counts.personal_memory_items, 1);
      assert.ok(
        inspected.blockers.some(
          (blocker) =>
            blocker.code === "PERSONAL_MEMORY_HISTORY_REQUIRES_REVIEW" &&
            blocker.count === 1,
        ),
      );
      assert.equal(
        /PRIVATE-MEMORY|@example\.test/.test(JSON.stringify(inspected)),
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

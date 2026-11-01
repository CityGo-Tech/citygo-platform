import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  ConversationTitles,
  Repository,
  connectDatabase,
  migrate,
} from "./index.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";

test("account maintenance inventories title evidence and refuses live or cleared title erasure without any write", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const userId = await new Repository(db).register(
    "title-retention@example.test",
    "synthetic",
  );
  const threadId = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,context)values($1,'support','{}')returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  const options = { expectedUserCount: 1, maintenanceConfirmed: true as const };
  const closed = new ClosedAccountRestart(db),
    fresh = new FreshAccountReset(db);
  const empty = await new ConversationTitles(db).update(userId, threadId, {
    title: null,
    expectedRevision: "0",
  });
  assert.equal(empty.revision, "0");
  const oldClosed = await closed.plan(options),
    oldFresh = await fresh.plan(options);
  assert.equal(oldClosed.counts.conversation_titles, 0);
  assert.equal(oldClosed.retained.includes("conversation_titles"), true);
  for (const plan of [
    oldClosed,
    oldFresh,
    await new AccountReset(db).plan(options),
  ]) {
    assert.equal(plan.counts.conversation_titles, 0);
    assert.equal(
      plan.blockers.some(
        (x) => x.code === "CONVERSATION_TITLES_REQUIRE_REVIEW",
      ),
      false,
    );
  }
  const common = {
    ...options,
    backupReceiptSha256: "b".repeat(64),
    servicesStoppedConfirmed: true as const,
    passwordHash: "synthetic-bootstrap-hash",
  };
  const titles = new ConversationTitles(db);
  await titles.update(userId, threadId, {
    title: "PRIVATE_TITLE_Семейный переезд",
    expectedRevision: "0",
  });
  for (const clear of [false, true]) {
    if (clear)
      await titles.update(userId, threadId, {
        title: null,
        expectedRevision: "1",
      });
    const before = await captureRestartRows(db);
    for (const tool of [new AccountReset(db), closed, fresh]) {
      const plan = await tool.plan(options);
      assert.equal(plan.counts.conversation_titles, 1);
      assert.deepEqual(
        plan.blockers.find(
          (x) => x.code === "CONVERSATION_TITLES_REQUIRE_REVIEW",
        ),
        {
          code: "CONVERSATION_TITLES_REQUIRE_REVIEW",
          count: 1,
        },
      );
      assert.doesNotMatch(
        JSON.stringify(plan),
        /PRIVATE_TITLE|title-retention/,
      );
      if ("retained" in plan)
        assert.equal(plan.retained.includes("conversation_titles"), true);
      if ("preservedTables" in plan) {
        assert.equal(
          plan.preservedTables.includes("conversation_titles"),
          true,
        );
        assert.equal(plan.erasedTables.includes("conversation_titles"), false);
      }
    }
    await assert.rejects(
      closed.apply({
        ...common,
        expectedSnapshotFingerprint: oldClosed.snapshotFingerprint,
        retainedAuditsReviewed: true,
      }),
      /изменились/,
    );
    await assert.rejects(
      fresh.apply({
        ...common,
        expectedSnapshotFingerprint: oldFresh.snapshotFingerprint,
        destructiveResetConfirmed: true,
      }),
      /изменились/,
    );
    await assert.rejects(
      closed.apply({
        ...common,
        expectedSnapshotFingerprint: (await closed.plan(options))
          .snapshotFingerprint,
        retainedAuditsReviewed: true,
      }),
      /заблокирован/,
    );
    await assert.rejects(
      fresh.apply({
        ...common,
        expectedSnapshotFingerprint: (await fresh.plan(options))
          .snapshotFingerprint,
        destructiveResetConfirmed: true,
      }),
      /заблокирован/,
    );
    assert.deepEqual(await captureRestartRows(db), before);
    const value = await titles.get(userId, threadId);
    assert.equal(value.title, clear ? null : "PRIVATE_TITLE_Семейный переезд");
    assert.equal(value.revision, clear ? "2" : "1");
  }
});

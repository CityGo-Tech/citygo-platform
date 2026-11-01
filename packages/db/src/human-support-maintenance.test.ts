import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  HumanSupportRequests,
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
} from "./index.js";
import { serviceConsentPolicy } from "@citygo/contracts";

test("support history blocks every existing account-maintenance transition without exposing or erasing question text", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(db),
    userId = await repo.register("support-preserve@example.test", "synthetic"),
    sessionTokenHash = createHash("sha256").update(randomUUID()).digest("hex");
  await repo.createSession(userId, sessionTokenHash);
  await new ServiceConsents(db).choose(userId, {
    policyVersion: serviceConsentPolicy.version,
    personalData: true,
    marketing: false,
  });
  const support = new HumanSupportRequests(db);
  const created = await support.create(
    { userId, sessionTokenHash },
    {
      operationId: randomUUID(),
      body: "PRIVATE_SUPPORT_Нужна помощь с первым шагом переезда.",
    },
  );
  await db.query("update users set role='admin' where id=$1", [userId]);
  const replied = await support.reply(
    { userId, sessionTokenHash },
    created.request.id,
    {
      operationId: randomUUID(),
      expectedRevision: 1,
      body: "PRIVATE_REPLY_Начните с выбора районов.",
    },
  );
  await support.markRead({ userId, sessionTokenHash }, created.request.id, {
    throughReplyId: replied.reply.id,
  });
  const before = (await db.query("select * from human_support_requests")).rows;
  const beforeReplies = (await db.query("select * from human_support_replies"))
    .rows;
  const beforeReads = (await db.query("select * from human_support_reads"))
    .rows;
  for (const reset of [
    new AccountReset(db),
    new ClosedAccountRestart(db),
    new FreshAccountReset(db),
  ]) {
    const plan = await reset.plan({
      expectedUserCount: 1,
      maintenanceConfirmed: true,
    });
    assert.equal(plan.counts.human_support_requests, 1);
    assert.equal(plan.counts.human_support_replies, 1);
    assert.equal(plan.counts.human_support_reads, 1);
    assert.deepEqual(
      plan.blockers.find(
        (b) => b.code === "HUMAN_SUPPORT_HISTORY_REQUIRES_REVIEW",
      ),
      {
        code: "HUMAN_SUPPORT_HISTORY_REQUIRES_REVIEW",
        count: 2,
      },
      "Existing content blockers keep counting the request and reply",
    );
    if ("retained" in plan)
      assert.ok(plan.retained.includes("human_support_reads"));
    if ("preservedTables" in plan)
      assert.equal(plan.erasedTables.includes("human_support_reads"), false);
    assert.doesNotMatch(
      JSON.stringify(plan),
      /PRIVATE_SUPPORT|PRIVATE_REPLY|support-preserve/,
    );
    assert.deepEqual(
      (await db.query("select * from human_support_reads")).rows,
      beforeReads,
    );
  }
  assert.deepEqual(
    (await db.query("select * from human_support_requests")).rows,
    before,
  );
  assert.deepEqual(
    (await db.query("select * from human_support_replies")).rows,
    beforeReplies,
  );
});

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
  await new HumanSupportRequests(db).create(
    { userId, sessionTokenHash },
    {
      operationId: randomUUID(),
      body: "PRIVATE_SUPPORT_Нужна помощь с первым шагом переезда.",
    },
  );
  const before = (await db.query("select * from human_support_requests")).rows;
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
    assert.ok(
      plan.blockers.some(
        (b) => b.code === "HUMAN_SUPPORT_HISTORY_REQUIRES_REVIEW",
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(plan),
      /PRIVATE_SUPPORT|support-preserve/,
    );
  }
  assert.deepEqual(
    (await db.query("select * from human_support_requests")).rows,
    before,
  );
});

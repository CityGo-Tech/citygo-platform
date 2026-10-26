import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  Repository,
  connectDatabase,
  migrate,
} from "./index.js";

test("all reset plans retain existing-account email proof and refuse reusing old erasure permission", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = await new Repository(db).register(
    "retained-confirmation@example.test",
    "synthetic-password-hash",
  );
  await db.query(
    `insert into account_email_confirmation_challenges
      (id,user_id,email,credential_digest,session_token_hash,proof_hash,code_hash,recipient_key,expires_at)
      values($1,$2,$3,$4,$4,$4,$4,$4,clock_timestamp()+interval '10 minutes')`,
    [randomUUID(), user, "retained-confirmation@example.test", "ab".repeat(32)],
  );
  const snapshot = async () =>
    (
      await db.query(
        `select jsonb_build_object(
          'challenges',(select jsonb_agg(to_jsonb(c)) from account_email_confirmation_challenges c),
          'users',(select jsonb_agg(to_jsonb(u) order by id) from users u),
          'verifications',(select jsonb_agg(to_jsonb(v)) from account_email_verifications v),
          'migrations',(select jsonb_agg(to_jsonb(m) order by name) from citygo_migrations m)
        ) as value`,
      )
    ).rows;
  const before = await snapshot();
  const options = { expectedUserCount: 1, maintenanceConfirmed: true };
  const plans = [
    await new AccountReset(db).plan(options),
    await new ClosedAccountRestart(db).plan(options),
    await new FreshAccountReset(db).plan(options),
  ];
  for (const plan of plans) {
    assert.equal(plan.dryRun, true);
    assert.equal(plan.accountsDeleted, 0);
    assert.equal(plan.counts.account_email_confirmation_challenges, 1);
    const retained = "retained" in plan ? plan.retained : plan.preservedTables;
    assert.ok(retained.includes("account_email_confirmation_challenges"));
    assert.ok(
      plan.blockers.some(
        (blocker) =>
          blocker.code ===
            "ACCOUNT_EMAIL_CONFIRMATION_HISTORY_REQUIRES_REVIEW" &&
          blocker.count === 1,
      ),
    );
  }
  assert.deepEqual(await snapshot(), before);
});

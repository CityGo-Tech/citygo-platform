import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AccountReset,
  ClosedAccountRestart,
  EmailRegistration,
  FreshAccountReset,
  PhoneContacts,
  PhoneVerification,
  configurePhoneVerification,
  connectDatabase,
  migrate,
  type PhoneVerificationPolicy,
} from "./index.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";
import { syntheticServiceConsents } from "./test-service-consents.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const policy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("synthetic-retained-contact-key"),
  normalizationVersion: "e164-v1",
  limits: {
    userHourly: 3,
    phoneHourly: 3,
    ipHourly: 10,
    cooldownSeconds: 0,
    globalDaily: 20,
    globalTotal: 100,
  },
};

test("reset and exact disposable rewinds retain active and unlinked contact proof, operator receipts and the original gift", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  assert.deepEqual(
    (
      await db.query(`select
    (select count(*)::int from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables,
    (select count(*)::int from pg_sequences where schemaname='public') as sequences,
    (select count(*)::int from citygo_migrations) as migrations`)
    ).rows,
    [{ tables: 71, sequences: 22, migrations: 38 }],
  );
  await configurePhoneVerification(db, policy);
  const email = new EmailRegistration(db),
    registration = {
      consents: syntheticServiceConsents,
      id: randomUUID(),
      email: "retained-phone-contact@example.test",
      passwordHash: "synthetic-password-hash",
      proofHash: hash("email-proof"),
      codeHash: hash("email-code"),
      recipientKey: hash("email-recipient"),
      ipKey: hash("email-ip"),
    };
  await email.begin(registration);
  await email.markSent(registration.id, registration.codeHash);
  const sessionTokenHash = hash("synthetic-contact-session"),
    account = await email.confirm({
      id: registration.id,
      proofHash: registration.proofHash,
      codeHash: registration.codeHash,
      sessionHash: sessionTokenHash,
    }),
    ctx = { userId: account.id, sessionTokenHash },
    phone = new PhoneVerification(db, policy),
    challenge = {
      id: randomUUID(),
      phoneKey: hash("synthetic-contact-phone"),
      proofHash: hash("phone-proof"),
      codeHash: hash("phone-code"),
      ipKey: hash("phone-ip"),
    };
  await phone.begin(ctx, challenge);
  await phone.markAccepted(challenge.id, challenge.codeHash);
  const gift = await phone.confirm(ctx, {
    id: challenge.id,
    phoneKey: challenge.phoneKey,
    proofHash: challenge.proofHash,
    codeHash: challenge.codeHash,
  });
  const { upgrade18RewindSql } = (await import(
    new URL("../../../scripts/release-upgrade-18-smoke.mjs", import.meta.url)
      .href
  )) as { upgrade18RewindSql: () => string };
  const rewinds = [upgrade18RewindSql()];
  for (const file of [
    "release-migration-smoke.mjs",
    "release-upgrade-12-smoke.mjs",
  ]) {
    const source = await readFile(
      new URL("../../../scripts/" + file, import.meta.url),
      "utf8",
    );
    const match =
      /psql\(\s*`(begin;\s*drop table payment_admission_commands,payment_admission_reconciliation_events,payment_admission;[\s\S]*?commit)`/.exec(
        source,
      );
    assert.ok(
      match,
      "Exercise the exact guarded fixture SQL, not a second copy",
    );
    assert.equal(match[1]!.includes("${"), false);
    rewinds.push(match[1]!);
  }
  const options = { expectedUserCount: 1, maintenanceConfirmed: true as const };
  for (const unlinked of [false, true]) {
    if (unlinked)
      await new PhoneContacts(db).changeByOperator({
        operationId: randomUUID(),
        fromUserId: account.id,
        toUserId: null,
        expectedSourceBindingId: gift.operationId,
        expectedPhoneKey: challenge.phoneKey,
        expectedPolicyFingerprint: (
          await db.query<{ policy_fingerprint: string }>(
            "select policy_fingerprint from phone_verification_control where id=1",
          )
        ).rows[0]!.policy_fingerprint,
        authoritySha256: hash("synthetic-authorized-owner-unlink"),
        reason: "owner-request",
      });
    const before = await captureRestartRows(db),
      closed = await new ClosedAccountRestart(db).plan(options),
      fresh = await new FreshAccountReset(db).plan(options),
      dry = await new AccountReset(db).plan(options);
    for (const plan of [dry, closed, fresh]) {
      assert.equal(plan.accountsDeleted, 0);
      assert.equal(plan.counts.phone_contact_bindings, 1);
      assert.equal(plan.counts.phone_contact_changes, unlinked ? 1 : 0);
      assert.ok(
        plan.blockers.some(
          (blocker) =>
            blocker.code === "PHONE_CONTACT_HISTORY_REQUIRES_REVIEW" &&
            blocker.count === (unlinked ? 2 : 1),
        ),
      );
      const retained =
        "retained" in plan ? plan.retained : plan.preservedTables;
      for (const name of ["phone_contact_bindings", "phone_contact_changes"])
        assert.ok(retained.includes(name));
    }
    for (const name of ["phone_contact_bindings", "phone_contact_changes"])
      assert.equal(fresh.erasedTables.includes(name), false);
    const common = {
      ...options,
      backupReceiptSha256: hash("synthetic-backup-receipt"),
      servicesStoppedConfirmed: true as const,
      passwordHash: "synthetic-reset-hash",
    };
    await assert.rejects(
      new ClosedAccountRestart(db).apply({
        ...common,
        expectedSnapshotFingerprint: closed.snapshotFingerprint,
        retainedAuditsReviewed: true,
      }),
      /заблокирован/,
    );
    await assert.rejects(
      new FreshAccountReset(db).apply({
        ...common,
        expectedSnapshotFingerprint: fresh.snapshotFingerprint,
        destructiveResetConfirmed: true,
      }),
      /заблокирован/,
    );
    for (const sql of rewinds) {
      await assert.rejects(
        db.exec(sql),
        /Phone contact history cannot be rewound/,
      );
      await db.exec("rollback");
      assert.deepEqual(
        await captureRestartRows(db),
        before,
        "No contact, command, claim, financial row or migration receipt is erased by a rejected rewind",
      );
    }
    assert.deepEqual(await captureRestartRows(db), before);
    assert.equal(before.phone_welcome_claims!.length, 1);
    assert.equal(before.ai_credit_entries!.length, 1);
    assert.equal(before.credit_source_lots!.length, 1);
  }
});

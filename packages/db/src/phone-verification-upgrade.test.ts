import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  EmailRegistration,
  PhoneVerification,
  configurePhoneVerification,
  connectDatabase,
  migrate,
  type Database,
  type PhoneVerificationPolicy,
} from "./index.js";
import {
  captureRestartRows,
  migrateLegacyRestartFixture,
  seedRestartFixture,
} from "./closed-account-restart-fixture.js";

const tables = [
  "phone_verification_challenges",
  "phone_verification_control",
  "phone_verification_sends",
  "phone_welcome_claims",
];
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const policy: PhoneVerificationPolicy = {
  identityKeyFingerprint: hash("synthetic-upgrade-key"),
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
async function through26(db: Database) {
  await migrateLegacyRestartFixture(db);
  await seedRestartFixture(db);
  await db.exec(
    "create table citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1)",
  );
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name > "0015_yookassa_orders.sql" &&
        name < "0027_phone_verification.sql",
    )
    .sort()) {
    const sql = await readFile(new URL(name, directory), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""));
      await tx.query(
        "insert into citygo_migrations(name,checksum) values($1,$2)",
        [name, hash(sql.replaceAll("\r\n", "\n"))],
      );
    });
  }
}
test("schema26→27 preserves all old accounts, financial rows, migration receipts, email evidence and sequences without phone backfill", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await through26(db);
  const email = new EmailRegistration(db),
    value = {
      id: randomUUID(),
      email: "synthetic-upgrade-email@example.test",
      passwordHash: "synthetic-hash",
      proofHash: hash("proof"),
      codeHash: hash("code"),
      recipientKey: hash("recipient"),
      ipKey: hash("ip"),
    };
  await email.begin(value);
  await email.markSent(value.id, value.codeHash);
  await email.confirm({
    id: value.id,
    proofHash: value.proofHash,
    codeHash: value.codeHash,
    sessionHash: hash("session"),
  });
  const before = await captureRestartRows(db),
    sequences = (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows;
  // Preserve this fixture's original schema26 -> 27 transition independently
  // of later migrations, each of which has its own upgrade regression.
  const migrationName = "0027_phone_verification.sql";
  const source = await readFile(
    new URL("../migrations/" + migrationName, import.meta.url),
    "utf8",
  );
  await db.transaction(async (tx) => {
    await tx.exec(
      source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
    );
    await tx.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [migrationName, hash(source.replaceAll("\r\n", "\n"))],
    );
  });
  const after = await captureRestartRows(db);
  for (const [name, rows] of Object.entries(before))
    assert.deepEqual(
      name === "citygo_migrations" ? after[name]!.slice(0, 26) : after[name],
      rows,
      name,
    );
  assert.deepEqual(
    Object.keys(after)
      .filter((name) => !(name in before))
      .sort(),
    [...tables].sort(),
  );
  for (const table of tables.filter(
    (name) => name !== "phone_verification_control",
  ))
    assert.deepEqual(after[table], []);
  assert.equal(after.phone_verification_control!.length, 1);
  assert.equal(after.citygo_migrations!.length, 27);
  assert.deepEqual(
    (
      await db.query(
        "select identity_key_fingerprint,policy_fingerprint,policy,bound_at from phone_verification_control",
      )
    ).rows,
    [
      {
        identity_key_fingerprint: null,
        policy_fingerprint: null,
        policy: null,
        bound_at: null,
      },
    ],
  );
  assert.deepEqual(
    (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows,
    sequences,
  );
});

for (const state of ["unbound", "bound-only", "pending", "claimed"] as const) {
  test(`old reset paths retain ${state} phone policy/history and never reopen its spent right`, async (t) => {
    const db = await connectDatabase("pglite://:memory:");
    t.after(() => db.close());
    await migrate(db);
    let count = 0;
    if (state !== "unbound") await configurePhoneVerification(db, policy);
    if (state === "pending" || state === "claimed") {
      const email = new EmailRegistration(db),
        value = {
          id: randomUUID(),
          email: "synthetic-reset-phone@example.test",
          passwordHash: "synthetic-hash",
          proofHash: hash("proof"),
          codeHash: hash("code"),
          recipientKey: hash("recipient"),
          ipKey: hash("ip"),
        };
      await email.begin(value);
      await email.markSent(value.id, value.codeHash);
      const account = await email.confirm({
          id: value.id,
          proofHash: value.proofHash,
          codeHash: value.codeHash,
          sessionHash: hash("session"),
        }),
        ctx = { userId: account.id, sessionTokenHash: hash("session") },
        phone = new PhoneVerification(db, policy),
        challenge = {
          id: randomUUID(),
          phoneKey: hash("phone"),
          proofHash: hash("phone-proof"),
          codeHash: hash("phone-code"),
          ipKey: hash("phone-ip"),
        };
      count = 1;
      await phone.begin(ctx, challenge);
      if (state === "claimed") {
        await phone.markAccepted(challenge.id, challenge.codeHash);
        await phone.confirm(ctx, {
          id: challenge.id,
          phoneKey: challenge.phoneKey,
          proofHash: challenge.proofHash,
          codeHash: challenge.codeHash,
        });
      }
    }
    const before = await captureRestartRows(db),
      options = { expectedUserCount: count, maintenanceConfirmed: true },
      closed = await new ClosedAccountRestart(db).plan(options),
      fresh = await new FreshAccountReset(db).plan(options);
    for (const plan of [closed, fresh])
      assert.equal(
        plan.blockers.some(
          (b) => b.code === "PHONE_VERIFICATION_HISTORY_REQUIRES_REVIEW",
        ),
        state !== "unbound",
      );
    for (const table of tables) {
      assert.ok(closed.retained.includes(table));
      assert.ok(fresh.preservedTables.includes(table));
      assert.equal(fresh.erasedTables.includes(table), false);
    }
    const dry = await new AccountReset(db).plan(options);
    for (const table of tables) {
      assert.ok(dry.retained.includes(table));
      assert.equal(dry.counts[table], before[table]!.length);
    }
    if (state !== "unbound") {
      const common = {
        expectedUserCount: count,
        backupReceiptSha256: "b".repeat(64),
        maintenanceConfirmed: true as const,
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
    }
    assert.deepEqual(await captureRestartRows(db), before);
  });
}

test("disposable schema rewinds fail closed on a bound phone identity before dropping history or forging an old journal", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await configurePhoneVerification(db, policy);
  const before = await captureRestartRows(db);
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
    assert.ok(match);
    assert.equal(match[1]!.includes("${"), false);
    rewinds.push(match[1]!);
  }
  for (const sql of rewinds) {
    await assert.rejects(
      db.exec(sql),
      /Phone verification history cannot be rewound/,
    );
    await db.exec("rollback");
    assert.deepEqual(await captureRestartRows(db), before);
  }
});

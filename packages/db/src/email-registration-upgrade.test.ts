import { syntheticServiceConsents } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import {
  AccountReset,
  ClosedAccountRestart,
  EmailRegistration,
  FreshAccountReset,
  connectDatabase,
  migrate,
  type Database,
} from "./index.js";
import {
  captureRestartRows,
  migrateLegacyRestartFixture,
  seedRestartFixture,
} from "./closed-account-restart-fixture.js";

const protectedTables = [
  "account_email_verifications",
  "email_registrations",
  "email_registration_rate_events",
];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function through25(db: Database) {
  const directory = new URL("../migrations/", import.meta.url);
  await db.exec(
    "create table if not exists citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1) on conflict do nothing",
  );
  for (const name of (await readdir(directory))
    .filter(
      (name) =>
        name.endsWith(".sql") &&
        name > "0015_yookassa_orders.sql" &&
        name < "0026_email_registration.sql",
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

test("schema25→26 preserves every old row, financial identity, sequence and migration receipt without verification backfill", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrateLegacyRestartFixture(db);
  await seedRestartFixture(db);
  await through25(db);
  assert.equal(
    (await db.query("select 1 from citygo_migrations")).rows.length,
    25,
  );
  const before = await captureRestartRows(db);
  const sequences = (
    await db.query<{ name: string; last_value: string | null }>(
      "select sequencename as name,last_value::text from pg_sequences where schemaname='public' order by sequencename",
    )
  ).rows;
  // This regression deliberately isolates the original 25 -> 26 transition.
  // Newer migrations have their own preservation/retention upgrade fixtures.
  const name = "0026_email_registration.sql";
  const source = await readFile(
    new URL("../migrations/" + name, import.meta.url),
    "utf8",
  );
  await db.transaction(async (tx) => {
    await tx.exec(
      source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
    );
    await tx.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [name, hash(source.replaceAll("\r\n", "\n"))],
    );
  });
  const after = await captureRestartRows(db);
  for (const [name, rows] of Object.entries(before)) {
    const current =
      name === "citygo_migrations"
        ? after[name]!.filter(
            (row) =>
              (row as { value: { name: string } }).value.name !==
              "0026_email_registration.sql",
          )
        : after[name];
    assert.deepEqual(current, rows, name);
  }
  assert.deepEqual(
    Object.keys(after)
      .filter((name) => !(name in before))
      .sort(),
    [...protectedTables].sort(),
  );
  for (const table of protectedTables) assert.deepEqual(after[table], []);
  for (const sequence of sequences)
    assert.deepEqual(
      (
        await db.query<{ name: string; last_value: string | null }>(
          "select sequencename as name,last_value::text from pg_sequences where schemaname='public' and sequencename=$1",
          [sequence.name],
        )
      ).rows,
      [sequence],
    );
  assert.equal(after.citygo_migrations!.length, 26);
});

for (const state of ["pending", "quotas-only", "verified"] as const) {
  test(`all old reset paths preserve and reject ${state} email-registration/anti-abuse history`, async (t) => {
    const db = await connectDatabase("pglite://:memory:");
    t.after(() => db.close());
    await migrate(db);
    let count = 0;
    if (state === "quotas-only")
      await db.query(
        "insert into email_registration_rate_events(kind,key_hash) values ('ip',$1)",
        [hash("synthetic-ip")],
      );
    else {
      const registration = new EmailRegistration(db),
        id = randomUUID();
      const value = {
        consents: syntheticServiceConsents,
        id,
        email: "synthetic-protected@example.test",
        passwordHash: "synthetic-hash",
        proofHash: hash("synthetic-proof"),
        codeHash: hash("synthetic-code"),
        recipientKey: hash("synthetic-recipient"),
        ipKey: hash("synthetic-ip"),
      };
      await registration.begin(value);
      if (state === "verified") {
        await registration.markSent(id, value.codeHash);
        await registration.confirm({
          id,
          proofHash: value.proofHash,
          codeHash: value.codeHash,
          sessionHash: hash("synthetic-session"),
        });
        count = 1;
      }
    }
    const before = await captureRestartRows(db),
      options = { expectedUserCount: count, maintenanceConfirmed: true };
    const restart = new ClosedAccountRestart(db),
      reset = new FreshAccountReset(db);
    const closed = await restart.plan(options),
      fresh = await reset.plan(options);
    for (const plan of [closed, fresh])
      assert.ok(
        plan.blockers.some(
          (blocker) =>
            blocker.code === "EMAIL_REGISTRATION_HISTORY_REQUIRES_REVIEW" &&
            blocker.count > 0,
        ),
      );
    for (const table of protectedTables) {
      assert.ok(closed.retained.includes(table));
      assert.ok(fresh.preservedTables.includes(table));
      assert.equal(fresh.erasedTables.includes(table), false);
    }
    const common = {
      expectedUserCount: count,
      backupReceiptSha256: "b".repeat(64),
      maintenanceConfirmed: true as const,
      servicesStoppedConfirmed: true as const,
      passwordHash: "synthetic-reset-hash",
    };
    await assert.rejects(
      restart.apply({
        ...common,
        expectedSnapshotFingerprint: closed.snapshotFingerprint,
        retainedAuditsReviewed: true,
      }),
      /заблокирован/,
    );
    await assert.rejects(
      reset.apply({
        ...common,
        expectedSnapshotFingerprint: fresh.snapshotFingerprint,
        destructiveResetConfirmed: true,
      }),
      /заблокирован/,
    );
    const dryRun = await new AccountReset(db).plan(options);
    for (const table of protectedTables) {
      assert.ok(dryRun.retained.includes(table));
      assert.equal(dryRun.counts[table], before[table]!.length);
    }
    assert.deepEqual(await captureRestartRows(db), before);
  });
}

test("disposable release rewind refuses populated verification data and rolls back any preceding DDL", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await db.query(
    "insert into email_registration_rate_events(kind,key_hash) values ('ip',$1)",
    [hash("synthetic-anti-abuse")],
  );
  const before = await captureRestartRows(db);
  for (const file of [
    "release-migration-smoke.mjs",
    "release-upgrade-12-smoke.mjs",
  ]) {
    const source = await readFile(
      new URL("../../../scripts/" + file, import.meta.url),
      "utf8",
    );
    const rewind =
      /psql\(\s*`(begin;\s*-- 0050 can be rewound[\s\S]*?commit)`/.exec(source);
    assert.ok(rewind, "Use the exact static fixture rewind");
    assert.equal(rewind[1]!.includes("${"), false);
    await assert.rejects(
      db.exec(rewind[1]!),
      /Email registration history cannot be rewound/,
    );
    await db.exec("rollback");
    assert.deepEqual(await captureRestartRows(db), before);
  }
});

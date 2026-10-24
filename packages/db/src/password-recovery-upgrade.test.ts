import {
  seedLegacyVerifiedEmail,
  applyFixtureMigration,
} from "./test-service-consents.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { connectDatabase } from "./index.js";
import {
  captureRestartRows,
  migrateLegacyRestartFixture,
  seedRestartFixture,
} from "./closed-account-restart-fixture.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

test("schema27 to29 preserves every account, verified email, wallet, financial row, message, session and migration receipt without recovery or personal-plan backfill", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrateLegacyRestartFixture(db);
  await seedRestartFixture(db);
  await db.exec(
    "create table citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1)",
  );
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter(
      (n) =>
        n.endsWith(".sql") &&
        n > "0015_yookassa_orders.sql" &&
        n < "0028_password_recovery.sql",
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
  await seedLegacyVerifiedEmail(db, "upgrade-verified@example.test");
  const before = await captureRestartRows(db),
    sequences = (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows;
  await applyFixtureMigration(db, "0028_password_recovery.sql");
  await applyFixtureMigration(db, "0029_personal_plan.sql");
  const after = await captureRestartRows(db);
  for (const [name, rows] of Object.entries(before))
    assert.deepEqual(
      name === "citygo_migrations" ? after[name]!.slice(0, 27) : after[name],
      rows,
      name,
    );
  assert.deepEqual(
    Object.keys(after).filter((name) => !(name in before)),
    ["password_recovery_challenges", "personal_plan_items"],
  );
  assert.deepEqual(after.password_recovery_challenges, []);
  assert.deepEqual(after.personal_plan_items, []);
  assert.equal(after.citygo_migrations!.length, 29);
  assert.deepEqual(
    (
      await db.query(
        "select sequencename,last_value::text from pg_sequences where schemaname='public' order by sequencename",
      )
    ).rows.filter((row) =>
      sequences.some((before) => before.sequencename === row.sequencename),
    ),
    sequences,
  );
  await applyFixtureMigration(db, "0028_password_recovery.sql");
  await applyFixtureMigration(db, "0029_personal_plan.sql");
  assert.deepEqual(await captureRestartRows(db), after);
});

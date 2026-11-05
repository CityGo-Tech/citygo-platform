import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  connectDatabase,
  migrate,
} from "./index.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("maintenance retains even unleased GigaChat account identity and literal rewinds refuse it before removing schema or old evidence", async (t) => {
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
    [{ tables: 80, sequences: 23, migrations: 48 }],
  );
  // A genuine capacity identity needs no invented model request, fee, provider
  // receipt or user. Even after use it remains a retained account configuration.
  await db.query(
    "insert into gigachat_account_leases(account_ref) values($1)",
    [hash("synthetic-retained-capacity")],
  );
  const before = await captureRestartRows(db);
  const options = { expectedUserCount: 0, maintenanceConfirmed: true as const };
  const dry = await new AccountReset(db).plan(options);
  const closed = await new ClosedAccountRestart(db).plan(options);
  const fresh = await new FreshAccountReset(db).plan(options);
  for (const plan of [dry, closed, fresh]) {
    assert.equal(plan.accountsDeleted, 0);
    assert.equal(plan.counts.gigachat_request_fees, 0);
    assert.equal(plan.counts.gigachat_account_leases, 1);
    assert.ok(
      plan.blockers.some(
        (b) => b.code === "GIGACHAT_HISTORY_REQUIRES_REVIEW" && b.count === 1,
      ),
    );
    for (const table of ["gigachat_request_fees", "gigachat_account_leases"])
      assert.ok(
        ("retained" in plan ? plan.retained : plan.preservedTables).includes(
          table,
        ),
      );
  }
  for (const table of ["gigachat_request_fees", "gigachat_account_leases"])
    assert.equal(fresh.erasedTables.includes(table), false);
  const common = {
    ...options,
    backupReceiptSha256: hash("synthetic-backup"),
    servicesStoppedConfirmed: true as const,
    passwordHash: "synthetic-reset-password-hash",
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
  const { upgrade18RewindSql } = (await import(
    new URL("../../../scripts/release-upgrade-18-smoke.mjs", import.meta.url)
      .href
  )) as { upgrade18RewindSql: () => string };
  const rewinds = [upgrade18RewindSql()];
  for (const name of [
    "release-migration-smoke.mjs",
    "release-upgrade-12-smoke.mjs",
  ]) {
    const source = await readFile(
      new URL("../../../scripts/" + name, import.meta.url),
      "utf8",
    );
    const match =
      /psql\(\s*`(begin;\s*-- 0047 private memory[\s\S]*?commit)`/.exec(source);
    assert.ok(match);
    assert.equal(match[1]!.includes("${"), false);
    rewinds.push(match[1]!);
  }
  for (const sql of rewinds) {
    await assert.rejects(
      db.exec(sql),
      /GigaChat fee or account lease history cannot be rewound/,
    );
    await db.exec("rollback");
    assert.deepEqual(await captureRestartRows(db), before);
  }
  assert.deepEqual(await captureRestartRows(db), before);
  assert.equal(before.gigachat_account_leases!.length, 1);
  assert.equal(before.gigachat_request_fees!.length, 0);
});

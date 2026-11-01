import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AiPolicy } from "@citygo/contracts";
import {
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  Repository,
  ServiceConsents,
  connectDatabase,
  migrate,
  type AiRequestModeSnapshot,
} from "./index.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("reset and literal disposable rewinds retain a real accepted mode snapshot without erasing its request, owner, counters or financial history", async (t) => {
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
    [{ tables: 76, sequences: 23, migrations: 44 }],
  );
  const repo = new Repository(db),
    user = await repo.register("retained-mode@example.test", "synthetic-hash");
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  const consent: AiPolicy = {
    id: hash("synthetic-consent-bundle"),
    provider: "routerai",
    model: "synthetic/bundle",
    version: "synthetic-v1",
    recipient: "Synthetic recipient",
    routing: "Synthetic routing",
    data: "Synthetic context",
  };
  await repo.initializeAiRouting(consent);
  const routing = await repo.aiRouting();
  const consents = new ServiceConsents(db, () => consent);
  await consents.choose(user, {
    policyVersion: (await consents.policy()).version,
    personalData: true,
    marketing: false,
  });
  const selected: AiPolicy = {
    ...consent,
    id: hash("synthetic-selected-policy"),
    model: "synthetic/balanced",
  };
  const modeSnapshot: AiRequestModeSnapshot = {
    mode: "balanced",
    catalogId: hash("synthetic-catalog"),
    policy: selected,
    execution: {
      key: hash("synthetic-execution"),
      policy: selected,
      maxInputBytes: 2048,
      maxOutputTokens: 64,
    },
    upstream: "synthetic-deepseek",
  };
  const requestId = randomUUID();
  const accepted = await repo.reserveChat(
    user,
    thread,
    requestId,
    "Synthetic user question",
    {
      policyId: consent.id,
      revision: routing.revision,
      userDailyLimit: 10,
      globalDailyLimit: 20,
      modeSnapshot,
    },
  );
  assert.deepEqual(accepted.modeSnapshot, modeSnapshot);
  // End only this synthetic request without calling any model or money adapter.
  await db.query(
    "update chat_requests set status='interrupted' where thread_id=$1 and request_id=$2",
    [thread, requestId],
  );
  await db.query(
    "update agent_threads set lease_token=null,busy_until=null where id=$1",
    [thread],
  );
  const before = await captureRestartRows(db),
    options = { expectedUserCount: 1, maintenanceConfirmed: true as const };
  const dry = await new AccountReset(db).plan(options),
    closed = await new ClosedAccountRestart(db).plan(options),
    fresh = await new FreshAccountReset(db).plan(options);
  for (const plan of [dry, closed, fresh]) {
    assert.equal(plan.accountsDeleted, 0);
    assert.equal(plan.counts.ai_request_modes, 1);
    assert.ok(
      plan.blockers.some(
        (b) =>
          b.code === "AI_REQUEST_MODE_HISTORY_REQUIRES_REVIEW" && b.count === 1,
      ),
    );
    assert.ok(
      ("retained" in plan ? plan.retained : plan.preservedTables).includes(
        "ai_request_modes",
      ),
    );
  }
  assert.equal(fresh.erasedTables.includes("ai_request_modes"), false);
  const common = {
    ...options,
    backupReceiptSha256: hash("synthetic-backup"),
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
      /AI request mode history cannot be rewound/,
    );
    await db.exec("rollback");
    assert.deepEqual(await captureRestartRows(db), before);
  }
  assert.deepEqual(await captureRestartRows(db), before);
  assert.equal(before.ai_request_modes!.length, 1);
  assert.equal(before.chat_requests!.length, 1);
  assert.equal(before.ai_model_attempts!.length, 0);
  assert.equal(before.ai_credit_entries!.length, 0);
});

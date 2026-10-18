import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  AccountAccess,
  ClosedAccountRestart,
  Repository,
  connectDatabase,
  migrate,
  type Database,
} from "./index.js";
import {
  captureRestartRows,
  retainedFinancialTables,
  seedRestartFixture,
  seedRestartNpdObligation,
  seedRestartRefundHistory,
} from "./closed-account-restart-fixture.js";

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const data = await seedRestartFixture(db);
  return { db, data, restart: new ClosedAccountRestart(db) };
}
async function prepared(restart: ClosedAccountRestart) {
  const plan = await restart.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  return {
    expectedUserCount: 2,
    expectedSnapshotFingerprint: plan.snapshotFingerprint,
    backupReceiptSha256: "b".repeat(64),
    maintenanceConfirmed: true as const,
    servicesStoppedConfirmed: true as const,
    retainedAuditsReviewed: true as const,
    passwordHash: "PRIVATE-NEW-BOOTSTRAP-HASH",
  };
}

test("closed restart plan is complete, stable, count-only and nonmutating", async (t) => {
  const { db, restart } = await fixture(t);
  const before = await captureRestartRows(db);
  const plan = await restart.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.equal(plan.operation, "closed-account-restart-plan");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.accountsDeleted, 0);
  assert.equal(plan.accountCount, 2);
  assert.equal(plan.expectedUserCount, 2);
  assert.equal(plan.bootstrapCompleted, false);
  assert.match(plan.snapshotFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(plan.counts.messages, 1);
  assert.equal(plan.counts.ai_credit_charges, 1);
  assert.equal(plan.counts.ai_model_attempts, 1);
  for (const table of retainedFinancialTables)
    assert.ok(plan.retained.includes(table), table);
  const serialized = JSON.stringify(plan);
  for (const privateText of [
    "PRIVATE-",
    "@example.test",
    "password_hash",
    "synthetic-generation",
  ])
    assert.equal(serialized.includes(privateText), false, privateText);
  assert.deepEqual(
    await restart.plan({ expectedUserCount: 2, maintenanceConfirmed: true }),
    plan,
  );
  assert.deepEqual(await captureRestartRows(db), before);
});

test("closed restart retires identity and conversations, preserving every financial value and original audit", async (t) => {
  const { db, data, restart } = await fixture(t);
  const before = await captureRestartRows(db, retainedFinancialTables);
  const oldAudits = (await db.query("select * from audit_log order by id"))
    .rows;
  const oldSubjects = (
    await db.query<{ auth_subject: string }>(
      "select auth_subject from users order by id",
    )
  ).rows.map((row) => row.auth_subject);
  const result = await restart.apply(await prepared(restart));
  assert.equal(result.operation, "closed-account-restart");
  assert.equal(result.dryRun, false);
  assert.equal(result.accountsDeleted, 0);
  assert.equal(result.accountsRetired, 2);
  assert.equal(result.accountingPreserved, true);
  assert.equal(result.publicIngressMayOpen, false);
  assert.equal(result.admin.username, "admin");
  assert.equal(result.admin.role, "super_admin");
  assert.equal(result.admin.mustChangePassword, true);
  assert.equal(JSON.stringify(result).includes("PRIVATE-"), false);
  assert.deepEqual(
    await captureRestartRows(db, retainedFinancialTables),
    before,
  );
  assert.deepEqual(
    (
      await db.query(
        "select * from audit_log where entity_type<>'account-maintenance' order by id",
      )
    ).rows,
    oldAudits,
  );
  const retired = (
    await db.query<{
      status: string;
      auth_subject: string;
      username: string | null;
      role: string;
      must_change_password: boolean;
    }>(
      "select status,auth_subject,username,role,must_change_password from users where id=any($1::bigint[]) order by id",
      [data.ids],
    )
  ).rows;
  assert.equal(retired.length, 2);
  for (const user of retired) {
    assert.equal(user.status, "deleted");
    assert.equal(user.username, null);
    assert.equal(user.role, "user");
    assert.equal(user.must_change_password, false);
    assert.equal(oldSubjects.includes(user.auth_subject), false);
  }
  for (const table of [
    "sessions",
    "messages",
    "agent_handoffs",
    "relocation_profiles",
    "questionnaire_answers",
    "relocation_plans",
    "user_quests",
    "xp_events",
    "consent_events",
    "ai_consents",
    "analytics_events",
    "r1_housing_briefs",
    "r1_housing_commands",
    "r1_housing_brief_revisions",
  ])
    assert.equal(
      (await db.query(`select 1 from ${table}`)).rows.length,
      0,
      table,
    );
  assert.deepEqual(
    (
      await db.query(
        "select context,status,lease_token,busy_until from agent_threads",
      )
    ).rows,
    [{ context: {}, status: "closed", lease_token: null, busy_until: null }],
  );
  assert.equal(
    (
      await db.query(
        "select 1 from user_credentials where user_id=any($1::bigint[])",
        [data.ids],
      )
    ).rows.length,
    0,
  );
  const access = new AccountAccess(db);
  assert.equal(
    await access.credentials("restart-owner@example.test"),
    undefined,
  );
  assert.equal(
    await new Repository(db).session("PRIVATE-OLD-SESSION"),
    undefined,
  );
  const admin = await access.credentials("admin");
  assert.ok(admin);
  assert.equal(admin.password_hash, "PRIVATE-NEW-BOOTSTRAP-HASH");
  assert.equal(data.ids.includes(admin.id), false);
  await assert.rejects(access.list(admin.id));
  await access.changePassword(
    admin.id,
    "PRIVATE-NEW-BOOTSTRAP-HASH",
    "PRIVATE-ROTATED-HASH",
    "c".repeat(64),
  );
  assert.equal((await access.info(admin.id))?.mustChangePassword, false);
  assert.equal((await access.list(admin.id)).length, 1);
  await assert.rejects(access.bootstrapAdmin("another-hash"));
});

test("full fingerprint catches changed private data, receipt, audit and schema even at the same account count", async (t) => {
  const { db, restart } = await fixture(t);
  const options = await prepared(restart);
  await db.query("update messages set content='DIFFERENT-PRIVATE-CHAT'");
  const next = await restart.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.notEqual(
    options.expectedSnapshotFingerprint,
    next.snapshotFingerprint,
  );
  const before = await captureRestartRows(db);
  await assert.rejects(restart.apply(options));
  assert.deepEqual(await captureRestartRows(db), before);
  const previous = next.snapshotFingerprint;
  await db.query(
    "update ai_credit_charges set receipt=jsonb_set(receipt,'{costRub}','\"0.1200000\"')",
  );
  const changedReceipt = await restart.plan({ expectedUserCount: 2 });
  assert.notEqual(changedReceipt.snapshotFingerprint, previous);
  await db.query(
    "update audit_log set payload=payload || '{\"reviewed\":true}'::jsonb",
  );
  const changedAudit = await restart.plan({ expectedUserCount: 2 });
  assert.notEqual(
    changedAudit.snapshotFingerprint,
    changedReceipt.snapshotFingerprint,
  );
  await db.exec(
    "create index synthetic_restart_schema_canary on messages(id,created_at)",
  );
  assert.notEqual(
    (await restart.plan({ expectedUserCount: 2 })).snapshotFingerprint,
    changedAudit.snapshotFingerprint,
  );
});

test("closed restart retains new NPD obligations and their delivery data byte-for-byte", async (t) => {
  const { db, data, restart } = await fixture(t);
  await seedRestartNpdObligation(db, data.user, true);
  const names = [...retainedFinancialTables, "ai_credit_topups"];
  const before = await captureRestartRows(db, names);
  const plan = await restart.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.equal(plan.counts.npd_receipt_tasks, 1);
  assert.equal(plan.counts.npd_receipt_commands, 2);
  assert.equal(plan.counts.npd_receipt_evidence, 1);
  assert.equal(plan.counts.npd_refund_observations, 1);
  assert.deepEqual(plan.blockers, []);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-|@example\.test/);
  await restart.apply(await prepared(restart));
  assert.deepEqual(await captureRestartRows(db, names), before);
});

test("closed restart preserves source lots, resolved allocations and monetary refund journal byte-for-byte", async (t) => {
  const { db, data, restart } = await fixture(t);
  await seedRestartRefundHistory(db, data.user, { canceled: true });
  const before = await captureRestartRows(db, retainedFinancialTables);
  const plan = await restart.plan({
    expectedUserCount: 2,
    maintenanceConfirmed: true,
  });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.counts.credit_source_lots, 2);
  assert.equal(plan.counts.credit_hold_allocations, 1);
  assert.equal(plan.counts.credit_refund_allocations, 1);
  assert.equal(plan.counts.payment_refunds, 1);
  assert.equal(plan.counts.payment_refund_events, 2);
  await restart.apply(await prepared(restart));
  assert.deepEqual(
    await captureRestartRows(db, retainedFinancialTables),
    before,
  );
});

test("closed restart rejects malformed or missing attestations without any write", async (t) => {
  const { db, restart } = await fixture(t);
  const options = await prepared(restart);
  const before = await captureRestartRows(db);
  for (const change of [
    { expectedUserCount: -1 },
    { expectedUserCount: 1 },
    { expectedSnapshotFingerprint: "not-a-fingerprint" },
    { backupReceiptSha256: "not-a-backup" },
    { maintenanceConfirmed: false },
    { servicesStoppedConfirmed: false },
    { retainedAuditsReviewed: false },
    { passwordHash: "" },
  ]) {
    await assert.rejects(
      restart.apply({ ...options, ...change } as typeof options),
    );
    assert.deepEqual(await captureRestartRows(db), before);
  }
  for (const expectedUserCount of [-1, 1.5, 1001, NaN, Infinity])
    await assert.rejects(restart.plan({ expectedUserCount }));
});

test("each unsafe blocker prevents the whole restart without changing accounting", async (t) => {
  const cases = [
    ["running chat", "update chat_requests set status='running'"],
    [
      "expired but unreleased lease",
      "update agent_threads set lease_token='expired-private-lease',busy_until=now()-interval '1 minute'",
    ],
    [
      "live lease",
      "update agent_threads set busy_until=now()+interval '1 minute'",
    ],
    ["held balance", "update ai_credit_accounts set held_micros=1"],
    ["missing receipt", "update ai_credit_charges set receipt=null"],
    [
      "external artifact",
      "insert into generated_artifacts(user_id,kind,storage_key) select min(id),'resume','PRIVATE-EXTERNAL-OBJECT' from users",
    ],
    [
      "unknown audit",
      "insert into audit_log(action,entity_type,payload) values ('unknown','unknown','{\"email\":\"PRIVATE-AUDIT\"}')",
    ],
  ] as const;
  for (const [name, statement] of cases)
    await t.test(name, async (t) => {
      const { db, restart } = await fixture(t);
      await db.exec(statement);
      const plan = await restart.plan({
        expectedUserCount: 2,
        maintenanceConfirmed: true,
      });
      assert.ok(plan.blockers.length > 0, name);
      const before = await captureRestartRows(db);
      await assert.rejects(restart.apply(await prepared(restart)), name);
      assert.deepEqual(await captureRestartRows(db), before);
    });
});

test("unknown public tables reject inventory before any reset write", async (t) => {
  const { db, restart } = await fixture(t);
  const options = await prepared(restart);
  await db.exec("create table synthetic_unknown_private_table(secret text)");
  await db.exec(
    "insert into synthetic_unknown_private_table values ('PRIVATE-UNKNOWN')",
  );
  const before = await captureRestartRows(db);
  await assert.rejects(
    restart.plan({ expectedUserCount: 2, maintenanceConfirmed: true }),
  );
  await assert.rejects(restart.apply(options));
  assert.deepEqual(await captureRestartRows(db), before);
});

test("an unresolved hold blocks retirement even if a corrupted account claims zero held", async (t) => {
  const { db, data, restart } = await fixture(t);
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'hold',1)",
    [data.user, randomUUID()],
  );
  const before = await captureRestartRows(db);
  await assert.rejects(restart.apply(await prepared(restart)));
  assert.deepEqual(await captureRestartRows(db), before);
});

test("a failure after the first erasure rolls back identities, financial rows and bootstrap", async (t) => {
  const { db, restart } = await fixture(t);
  const options = await prepared(restart);
  const before = await captureRestartRows(db);
  let injected = false;
  const failing: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (!injected && /\bdelete\s+from\b/i.test(sql)) {
              injected = true;
              throw new Error("Synthetic failure after erasure");
            }
            return result;
          },
          exec: async (sql) => {
            await tx.exec(sql);
            if (!injected && /\bdelete\s+from\b/i.test(sql)) {
              injected = true;
              throw new Error("Synthetic failure after erasure");
            }
          },
        }),
      ),
  };
  await assert.rejects(new ClosedAccountRestart(failing).apply(options));
  assert.equal(
    injected,
    true,
    "Failure must occur after an actual erasure statement",
  );
  assert.deepEqual(await captureRestartRows(db), before);
});

test("post-bootstrap triggers cannot mutate retained money or resurrect erased conversations", async (t) => {
  for (const scenario of ["money", "conversation"] as const)
    await t.test(scenario, async (t) => {
      const { db, data, restart } = await fixture(t);
      const body =
        scenario === "money"
          ? "update public.ai_budget set total_reserved_micros=total_reserved_micros+1 where id=1;"
          : `insert into public.messages(thread_id,role,content) values (${data.thread},'system','PRIVATE-RESURRECTED');`;
      assert.match(data.thread, /^[1-9][0-9]*$/);
      await db.exec(`
        create function public.synthetic_restart_post_admin() returns trigger
        language plpgsql as $synthetic$
        begin
          if new.username='admin' then ${body} end if;
          return new;
        end
        $synthetic$;
        create trigger synthetic_restart_post_admin after insert on public.users
        for each row execute function public.synthetic_restart_post_admin();
      `);
      const options = await prepared(restart);
      const before = await captureRestartRows(db);
      await assert.rejects(restart.apply(options));
      assert.deepEqual(await captureRestartRows(db), before);
      assert.equal(
        (
          await db.query<{ bootstrap_completed: boolean }>(
            "select bootstrap_completed from account_security_state where id=1",
          )
        ).rows[0]!.bootstrap_completed,
        false,
      );
    });
});

test("deferred post-bootstrap trigger is forced before final scans and cannot commit a changed budget", async (t) => {
  const { db, restart } = await fixture(t);
  // Install BEFORE approval: this trigger belongs to the approved schema rather
  // than causing a superficial stale-fingerprint rejection. Without forcing
  // deferred triggers, its mutation runs only after the final invariant scans.
  await db.exec(`
    create function public.synthetic_restart_deferred_budget() returns trigger
    language plpgsql as $synthetic$
    begin
      if new.username='admin' then
        update public.ai_budget
          set total_reserved_micros=total_reserved_micros+1 where id=1;
      end if;
      return new;
    end
    $synthetic$;
    create constraint trigger synthetic_restart_deferred_budget
      after insert on public.users deferrable initially deferred
      for each row execute function public.synthetic_restart_deferred_budget();
  `);
  const options = await prepared(restart);
  const before = await captureRestartRows(db);
  await assert.rejects(restart.apply(options), {
    statusCode: 500,
    message: "Итоговый учёт изменился; транзакция отменена",
  });
  // Exact equality includes original receipts/balances, private messages and
  // credentials, the old admin identity, sessions and bootstrap_completed=false.
  assert.deepEqual(await captureRestartRows(db), before);
});

test("closed restart is one-time and never recreates a known bootstrap credential", async (t) => {
  const { db, restart } = await fixture(t);
  const options = await prepared(restart);
  await restart.apply(options);
  const before = await captureRestartRows(db);
  await assert.rejects(restart.apply(options));
  await assert.rejects(
    restart.apply({
      ...options,
      expectedUserCount: 3,
      expectedSnapshotFingerprint: (
        await restart.plan({ expectedUserCount: 3 })
      ).snapshotFingerprint,
    }),
  );
  assert.deepEqual(await captureRestartRows(db), before);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connectDatabase, migrate } from "./index.js";
import {
  seedRestartFixture,
  seedRestartNpdObligation,
  seedRestartRefundHistory,
} from "./closed-account-restart-fixture.js";

const tables = [
  "npd_receipt_tasks",
  "npd_receipt_commands",
  "npd_receipt_evidence",
  "npd_refund_observations",
  "credit_source_lots",
  "credit_hold_allocations",
  "credit_refund_allocations",
  "payment_refunds",
  "payment_refund_events",
  "payment_notification_inbox",
  "credit_charge_debts",
  "credit_debt_repayments",
];

test("the disposable release fixture rewinds only reviewed empty new schema and reapplies all current migrations", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const source = await readFile(
    new URL("../../../scripts/release-migration-smoke.mjs", import.meta.url),
    "utf8",
  );
  const rewind =
    /psql\(\s*`(begin;\s*-- 0050 can be rewound[\s\S]*?commit)`/.exec(source);
  assert.ok(
    rewind,
    "Test the exact static disposable rewind, not a second copy",
  );
  assert.equal(rewind[1]!.includes("${"), false);
  assert.match(rewind[1]!, /drop table user_acquisition;/);
  assert.match(
    rewind[1]!,
    /alter table email_registrations drop column landing_attribution;/,
  );
  await db.exec(rewind[1]!);
  assert.equal(
    (await db.query("select 1 from citygo_migrations")).rows.length,
    9,
  );
  for (const table of [
    "user_acquisition",
    "conversation_memory_fragments",
    "human_support_requests",
    "human_support_reads",
    "personal_plan_item_history",
    "service_consent_events",
    "password_recovery_challenges",
    "account_email_verifications",
    "account_email_confirmation_challenges",
    "phone_contact_bindings",
    "phone_contact_changes",
    "ai_postpay_attempts",
    "credit_postpay_liabilities",
    "credit_postpay_repayments",
    "ai_request_modes",
    "ai_request_consent_bases",
    "gigachat_request_fees",
    "gigachat_account_leases",
    "email_registrations",
    "email_registration_rate_events",
    ...tables,
    "payment_admission",
    "payment_admission_commands",
    "payment_admission_reconciliation_events",
  ])
    assert.equal(
      (
        await db.query<{ relation: string | null }>(
          "select to_regclass($1)::text as relation",
          [table],
        )
      ).rows[0]!.relation,
      null,
    );
  for (const name of [
    "citygo_guard_user_acquisition",
    "citygo_guard_registration_attribution",
    "citygo_valid_landing_attribution",
    "citygo_guard_conversation_memory_fragment",
    "citygo_reject_conversation_memory_update",
    "citygo_guard_human_support_request",
    "citygo_guard_support_read",
    "citygo_guard_personal_plan_history",
    "citygo_guard_password_recovery",
    "citygo_guard_account_email_confirmation",
    "citygo_guard_account_email_verification_proof",
    "citygo_guard_phone_contact_binding",
    "citygo_guard_phone_contact_change",
    "citygo_guard_phone_contact_completion",
    "citygo_guard_protected_phone_contact",
    "citygo_guard_postpay_attempt",
    "citygo_guard_postpay_liability",
    "citygo_check_postpay_conservation",
    "citygo_guard_ai_request_mode",
    "citygo_guard_ai_mode_attempt",
    "citygo_guard_gigachat_request_fee",
    "citygo_guard_gigachat_account_lease",
    "citygo_check_gigachat_fee_conservation",
    "citygo_guard_npd_receipt_task",
    "citygo_create_npd_receipt_task",
    "citygo_apply_npd_refund_observation",
    "citygo_guard_credit_source_lot",
    "citygo_create_credit_gift_lot",
    "citygo_create_credit_paid_lot",
    "citygo_guard_credit_allocation",
    "guard_payment_refund_identity",
    "guard_payment_refund_event_immutable",
    "citygo_guard_payment_notification",
    "citygo_guard_payment_admission_history",
    "citygo_guard_credit_debt_identity",
    "citygo_guard_charge_reservation_mode",
    "citygo_apply_credit_debt_repayments",
    "citygo_repay_credit_debt_from_new_source",
    "citygo_check_credit_debt_conservation",
    "citygo_guard_email_registration",
  ])
    assert.equal(
      (await db.query("select 1 from pg_proc where proname=$1", [name])).rows
        .length,
      0,
    );
  assert.equal(
    (
      await db.query<{ relation: string | null }>(
        "select to_regclass('public.messages_memory_sources_idx')::text as relation",
      )
    ).rows[0]!.relation,
    null,
  );
  await migrate(db);
  assert.equal(
    (await db.query("select 1 from citygo_migrations")).rows.length,
    50,
  );
});

test("reviewed NPD grants support invoker duties/session locks but not identity rewrites, history deletion or Worker access", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const data = await seedRestartFixture(db);
  await db.exec(
    "create role citygo_api; create role citygo_worker; create role citygo_backup;",
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  await db.exec(grants.replace(/^\\set[^\n]*\n/gm, ""));
  for (const table of tables) {
    const permissions = (
      await db.query<{
        can_read: boolean;
        can_append: boolean;
        can_backup_read: boolean;
        broad: boolean;
      }>(
        `select has_table_privilege('citygo_api',$1,'SELECT') as can_read,
          has_table_privilege('citygo_api',$1,'INSERT') as can_append,
          has_table_privilege('citygo_backup',$1,'SELECT') as can_backup_read,
          (has_table_privilege('citygo_api',$1,'UPDATE') or
           has_table_privilege('citygo_api',$1,'DELETE') or
           has_table_privilege('citygo_api',$1,'TRUNCATE') or
           has_table_privilege('citygo_worker',$1,'SELECT')) as broad`,
        [table],
      )
    ).rows[0]!;
    assert.deepEqual(permissions, {
      can_read: true,
      can_append: true,
      can_backup_read: true,
      broad: false,
    });
  }
  for (const column of [
    "buyer_email",
    "amount_kopeks",
    "user_id",
    "payment_id",
  ])
    assert.equal(
      (
        await db.query<{ writable: boolean }>(
          "select has_column_privilege('citygo_api','npd_receipt_tasks',$1,'UPDATE') as writable",
          [column],
        )
      ).rows[0]!.writable,
      false,
    );
  await db.exec("set role citygo_api");
  const obligation = await seedRestartNpdObligation(db, data.user);
  await db.transaction(async (tx) => {
    await tx.query("select token_hash from sessions for update");
    await tx.query("select id from npd_receipt_tasks where id=$1 for update", [
      obligation.operationId,
    ]);
  });
  await assert.rejects(
    db.query("update npd_receipt_tasks set buyer_email='changed@example.test'"),
    /permission denied/,
  );
  for (const table of tables) {
    await assert.rejects(db.exec(`delete from ${table}`), /permission denied/);
    await assert.rejects(
      db.exec(`truncate table ${table}`),
      /permission denied/,
    );
  }
  for (const table of [
    "npd_receipt_commands",
    "npd_receipt_evidence",
    "npd_refund_observations",
    "payment_refund_events",
    "credit_charge_debts",
    "credit_debt_repayments",
  ])
    await assert.rejects(
      db.exec(`update ${table} set created_at=created_at`),
      /permission denied/,
    );
  await db.exec("reset role; set role citygo_worker");
  for (const table of tables)
    await assert.rejects(
      db.query(`select * from ${table}`),
      /permission denied/,
    );
  await db.exec("reset role; set role citygo_backup");
  assert.equal(
    (await db.query("select 1 from npd_receipt_tasks")).rows.length,
    1,
  );
  await db.exec("reset role");
});

test("refund/source grants allow observations, not frozen identity, history rewrites or Worker access", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const data = await seedRestartFixture(db);
  await db.exec(
    "create role citygo_api; create role citygo_worker; create role citygo_backup;",
  );
  const grants = await readFile(
    new URL("../../../deploy/postgres/grants.sql", import.meta.url),
    "utf8",
  );
  await db.exec(grants.replace(/^\\set[^\n]*\n/gm, ""));
  for (const [table, mutable, frozen] of [
    [
      "credit_source_lots",
      [
        "spent_micros",
        "held_micros",
        "refund_reserved_micros",
        "refunded_micros",
      ],
      ["user_id", "kind", "gross_micros", "paid_operation_id"],
    ],
    [
      "credit_hold_allocations",
      ["spent_micros", "state"],
      ["hold_id", "source_lot_id", "reserved_micros"],
    ],
    [
      "credit_refund_allocations",
      ["state"],
      [
        "refund_id",
        "user_id",
        "source_lot_id",
        "amount_micros",
        "refunded_before_kopeks",
      ],
    ],
    [
      "payment_refunds",
      [
        "status",
        "revision",
        "provider_refund_id",
        "attempt_count",
        "last_attempt_at",
        "dispatch_token",
        "dispatch_lease_until",
        "review_reason",
        "updated_at",
      ],
      [
        "user_id",
        "request_id",
        "payment_operation_id",
        "provider_payment_id",
        "merchant_id",
        "test",
        "amount_kopeks",
        "payment_amount_kopeks",
        "refunded_before_kopeks",
        "created_at",
      ],
    ],
  ] as const) {
    for (const [columns, expected] of [
      [mutable, true],
      [frozen, false],
    ] as const)
      for (const column of columns)
        assert.equal(
          (
            await db.query<{ writable: boolean }>(
              "select has_column_privilege('citygo_api',$1,$2,'UPDATE') as writable",
              [table, column],
            )
          ).rows[0]!.writable,
          expected,
          `${table}.${column}`,
        );
  }
  await db.exec("set role citygo_api");
  const source = await seedRestartRefundHistory(db, data.user, {
    canceled: true,
  });
  await assert.rejects(
    db.query("update payment_refunds set amount_kopeks=100 where id=$1", [
      source.refundId,
    ]),
    /permission denied/,
  );
  await assert.rejects(
    db.exec("update payment_refund_events set payload='{}'"),
    /permission denied/,
  );
  await db.exec("reset role");
  // Even an owner cannot silently rewrite or delete append-only monetary proof.
  await assert.rejects(
    db.exec("update payment_refund_events set payload='{}'"),
    /append only/,
  );
  await assert.rejects(
    db.exec("delete from payment_refund_events"),
    /append only/,
  );
});

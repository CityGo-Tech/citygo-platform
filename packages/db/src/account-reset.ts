import { createHash } from "node:crypto";
import type { Database } from "./index.js";
import { DomainError } from "./errors.js";

export type AccountResetBlocker = { code: string; count: number };
export type AccountResetPlan = {
  operation: "account-reset-plan";
  dryRun: true;
  writesEnabled: false;
  accountsDeleted: 0;
  accountCount: number;
  expectedUserCount: number | null;
  accountSetFingerprint: string;
  bootstrapCompleted: boolean;
  maintenanceConfirmed: boolean;
  counts: Record<string, number>;
  blockers: AccountResetBlocker[];
  retained: string[];
};

// An inventory, NOT a deletion whitelist. In particular, cascading users would
// erase priced-attempt snapshots and can break credit/accounting foreign keys.
const ownedTables = [
  "personal_memory_items",
  "personal_plan_items",
  "user_credentials",
  "sessions",
  "relocation_profiles",
  "questionnaire_answers",
  "relocation_plans",
  "user_quests",
  "xp_events",
  "agent_threads",
  "generated_artifacts",
  "consent_events",
  "ai_consents",
  "ai_user_usage_daily",
  "ai_user_model_attempt_daily",
  "ai_model_attempts",
  "r1_housing_briefs",
  "r1_housing_commands",
  "analytics_events",
  "ai_credit_accounts",
  "ai_credit_charges",
] as const;
const retained = [
  "service_consent_events",
  "phone_verification_control",
  "phone_verification_challenges",
  "phone_verification_sends",
  "phone_welcome_claims",
  "password_recovery_challenges",
  "account_email_verifications",
  "email_registrations",
  "email_registration_rate_events",
  "citygo_migrations",
  "citygo_migration_lock",
  "account_security_state",
  "quests",
  "knowledge_sources",
  "ai_routing",
  "ai_budget",
  "ai_budget_daily",
  "ai_usage_daily",
  "ai_model_attempt_daily",
  "ai_model_attempts",
  "ai_credit_entries",
  "ai_credit_charges",
  "payment_admission",
  "payment_admission_commands",
  "payment_admission_reconciliation_events",
  "operational_ai_audit",
  "server_secrets",
  "backups_and_external_storage",
];

export class AccountReset {
  constructor(private db: Database) {}

  // No apply method deliberately exists. Authorization to discard test profiles
  // is not authorization to discard real provider charges or unresolved holds.
  async plan(
    options: {
      expectedUserCount?: number;
      maintenanceConfirmed?: boolean;
    } = {},
  ): Promise<AccountResetPlan> {
    const expected = options.expectedUserCount;
    if (
      expected !== undefined &&
      (!Number.isSafeInteger(expected) || expected < 0 || expected > 1000)
    )
      throw new DomainError(
        400,
        "Ожидаемое число аккаунтов должно быть от 0 до 1000",
      );
    return this.db.transaction(async (tx) => {
      await tx.exec(
        "set local lock_timeout='3s'; set local statement_timeout='10s'",
      );
      const state = (
        await tx.query<{ bootstrap_completed: boolean }>(
          "select bootstrap_completed from account_security_state where id=1 for update",
        )
      ).rows[0];
      if (!state) throw new DomainError(503, "Хранилище аккаунтов не готово");
      // This short, operator-only lock also serializes ordinary registration.
      // Row locks below follow AccountAccess's singleton -> numeric users order.
      await tx.exec("lock table users in share row exclusive mode");
      const users = (
        await tx.query<{ id: string; auth_subject: string }>(
          "select id::text,auth_subject from users order by users.id for update",
        )
      ).rows;
      if (users.length > 1000)
        throw new DomainError(
          409,
          "Инструмент ограничен небольшим тестовым контуром",
        );
      const ids = users.map((user) => user.id);
      const counts: Record<string, number> = { users: users.length };
      const count = async (name: string, query: string) => {
        const value = (await tx.query<{ count: number }>(query, [ids])).rows[0]!
          .count;
        counts[name] = value;
        return value;
      };
      for (const table of ownedTables)
        await count(
          table,
          `select count(*)::int as count from ${table} where user_id=any($1::bigint[])`,
        );
      for (const table of ["messages", "agent_handoffs", "chat_requests"])
        await count(
          table,
          `select count(*)::int as count from ${table} x join agent_threads t on t.id=x.thread_id where t.user_id=any($1::bigint[])`,
        );
      await count(
        "r1_housing_brief_revisions",
        "select count(*)::int as count from r1_housing_brief_revisions r join r1_housing_briefs b on b.id=r.brief_id where b.user_id=any($1::bigint[])",
      );
      await count(
        "ai_credit_entries",
        "select count(*)::int as count from ai_credit_entries where user_id=any($1::bigint[]) or actor_user_id=any($1::bigint[])",
      );
      await count(
        "audit_log_owned_or_acted",
        "select count(*)::int as count from audit_log where actor_user_id=any($1::bigint[]) or (entity_type in ('account','ai-credit') and entity_id=any($1::text[]))",
      );
      // A retained singleton and append-only audit, not a deletion whitelist.
      // Security lock above serializes the supported admission writers.
      for (const table of [
        "service_consent_events",
        "phone_verification_control",
        "phone_verification_challenges",
        "phone_verification_sends",
        "phone_welcome_claims",
        "password_recovery_challenges",
        "account_email_verifications",
        "email_registrations",
        "email_registration_rate_events",
        "payment_admission",
        "payment_admission_commands",
        "payment_admission_reconciliation_events",
      ])
        counts[table] = (
          await tx.query<{ count: number }>(
            `select count(*)::int as count from ${table}`,
          )
        ).rows[0]!.count;
      const blockers: AccountResetBlocker[] = [
        { code: "RESET_APPLY_NOT_IMPLEMENTED", count: 1 },
      ];
      if (expected === undefined)
        blockers.push({ code: "EXPECTED_USER_COUNT_NOT_PINNED", count: 1 });
      else if (expected !== users.length)
        blockers.push({ code: "EXPECTED_USER_COUNT_MISMATCH", count: 1 });
      if (options.maintenanceConfirmed !== true)
        blockers.push({ code: "MAINTENANCE_NOT_CONFIRMED", count: 1 });
      const block = async (
        code: string,
        query: string,
        params: unknown[] = [ids],
      ) => {
        const value = (await tx.query<{ count: number }>(query, params))
          .rows[0]!.count;
        if (value) blockers.push({ code, count: value });
      };
      if (counts.payment_admission !== 1)
        blockers.push({
          code: "PAYMENT_ADMISSION_STATE_UNAVAILABLE",
          count: 1,
        });
      const admissionHistoryCount =
        counts.payment_admission_commands! +
        counts.payment_admission_reconciliation_events!;
      if (admissionHistoryCount)
        blockers.push({
          code: "PAYMENT_ADMISSION_HISTORY_PRESENT",
          count: admissionHistoryCount,
        });
      await block(
        "PAYMENT_ADMISSION_LINKED_OR_ACTIVE",
        `select count(*)::int as count from payment_admission where
         (owner_user_id is not null or accepting_new_checkouts or mode<>'closed'
          or reconciliation_enabled or reconciliation_run_id is not null
          or reconciliation_run_revision is not null or reconciliation_run_until is not null)`,
        [],
      );
      await block(
        "ACTIVE_CHAT_REQUESTS",
        "select count(*)::int as count from chat_requests r join agent_threads t on t.id=r.thread_id where t.user_id=any($1::bigint[]) and r.status='running'",
      );
      await block(
        "UNRELEASED_GENERATION_LEASES",
        "select count(*)::int as count from agent_threads where user_id=any($1::bigint[]) and (lease_token is not null or busy_until>now())",
      );
      await block(
        "NONZERO_CREDIT_BALANCES",
        "select count(*)::int as count from ai_credit_accounts where user_id=any($1::bigint[]) and (granted_micros<>0 or held_micros<>0 or spent_micros<>0)",
      );
      await block(
        "PENDING_CREDIT_HOLDS",
        "select count(*)::int as count from ai_credit_entries h where h.user_id=any($1::bigint[]) and h.kind='hold' and not exists (select 1 from ai_credit_entries r where r.hold_id=h.operation_id)",
      );
      await block(
        "UNRECONCILED_PROVIDER_CHARGES",
        "select count(*)::int as count from ai_credit_charges where user_id=any($1::bigint[]) and receipt is null",
      );
      if (
        counts.ai_model_attempts ||
        counts.ai_credit_entries ||
        counts.ai_credit_charges
      )
        blockers.push({
          code: "ACCOUNTING_ANONYMIZATION_REQUIRED",
          count:
            counts.ai_model_attempts! +
            counts.ai_credit_entries! +
            counts.ai_credit_charges!,
        });
      if (counts.generated_artifacts)
        blockers.push({
          code: "EXTERNAL_ARTIFACT_INVENTORY_REQUIRED",
          count: counts.generated_artifacts,
        });
      // Audits may contain copied personal context without an ownership FK. No
      // blanket JSON/text pruning or deletion of operational financial history.
      const audits = (
        await tx.query<{ count: number }>(
          "select count(*)::int as count from audit_log where actor_user_id is null and entity_type not in ('ai-routing','ai-budget','account-maintenance')",
        )
      ).rows[0]!.count;
      if (audits)
        blockers.push({
          code: "UNATTRIBUTED_AUDIT_REVIEW_REQUIRED",
          count: audits,
        });
      return {
        operation: "account-reset-plan",
        dryRun: true,
        writesEnabled: false,
        accountsDeleted: 0,
        accountCount: users.length,
        expectedUserCount: expected ?? null,
        accountSetFingerprint: createHash("sha256")
          .update(JSON.stringify(users))
          .digest("hex"),
        bootstrapCompleted: state.bootstrap_completed,
        maintenanceConfirmed: options.maintenanceConfirmed === true,
        counts,
        blockers,
        retained: [...retained],
      };
    });
  }
}

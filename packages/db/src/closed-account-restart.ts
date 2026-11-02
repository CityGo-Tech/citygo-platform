import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import type { AccountResetBlocker } from "./account-reset.js";

// One operator-only transition before the FIRST administrator bootstrap. This
// is not account deletion, a public erasure API, a migration, or a reset job.
const tables = [
  "human_support_requests",
  "human_support_replies",
  "human_support_reads",
  "conversation_titles",
  "service_consent_events",
  "personal_plan_checklists",
  "personal_plan_item_history",
  "personal_plan_items",
  "password_recovery_challenges",
  "account_email_confirmation_challenges",
  "account_email_verifications",
  "account_security_state",
  "agent_handoffs",
  "agent_threads",
  "ai_budget",
  "ai_budget_daily",
  "ai_consents",
  "ai_credit_accounts",
  "ai_credit_charges",
  "ai_credit_entries",
  "ai_credit_topups",
  "ai_model_attempt_daily",
  "ai_model_attempts",
  "ai_routing",
  "ai_usage_daily",
  "ai_user_model_attempt_daily",
  "ai_user_usage_daily",
  "analytics_events",
  "audit_log",
  "chat_requests",
  "citygo_migration_lock",
  "citygo_migrations",
  "consent_events",
  "ai_postpay_attempts",
  "credit_postpay_liabilities",
  "credit_postpay_repayments",
  "credit_charge_debts",
  "credit_debt_repayments",
  "credit_hold_allocations",
  "credit_refund_allocations",
  "credit_source_lots",
  "email_registrations",
  "email_registration_rate_events",
  "generated_artifacts",
  "knowledge_sources",
  "messages",
  "npd_receipt_commands",
  "npd_receipt_evidence",
  "npd_receipt_tasks",
  "npd_refund_observations",
  "payment_admission",
  "payment_admission_commands",
  "payment_admission_reconciliation_events",
  "payment_notification_inbox",
  "payment_refund_events",
  "payment_refunds",
  "payment_topup_orders",
  "phone_verification_challenges",
  "phone_verification_control",
  "phone_verification_sends",
  "phone_welcome_claims",
  "phone_contact_bindings",
  "phone_contact_changes",
  "ai_request_modes",
  "ai_request_consent_bases",
  "gigachat_request_fees",
  "gigachat_account_leases",
  "questionnaire_answers",
  "quests",
  "r1_housing_brief_revisions",
  "r1_housing_briefs",
  "r1_housing_commands",
  "relocation_plans",
  "relocation_profiles",
  "sessions",
  "user_credentials",
  "user_quests",
  "users",
  "xp_events",
] as const;
// No money, attempt, receipt, policy, migration, catalog or usage row is rewritten.
const retainedTables = [
  "human_support_requests",
  "human_support_replies",
  "human_support_reads",
  "conversation_titles",
  "service_consent_events",
  "personal_plan_checklists",
  "personal_plan_item_history",
  "personal_plan_items",
  "phone_verification_challenges",
  "phone_verification_control",
  "phone_verification_sends",
  "phone_welcome_claims",
  "phone_contact_bindings",
  "phone_contact_changes",
  "ai_request_modes",
  "ai_request_consent_bases",
  "gigachat_request_fees",
  "gigachat_account_leases",
  "password_recovery_challenges",
  "account_email_confirmation_challenges",
  "account_email_verifications",
  "email_registrations",
  "email_registration_rate_events",
  "ai_postpay_attempts",
  "credit_postpay_liabilities",
  "credit_postpay_repayments",
  "credit_charge_debts",
  "credit_debt_repayments",
  "credit_hold_allocations",
  "credit_refund_allocations",
  "credit_source_lots",
  "payment_refund_events",
  "payment_refunds",
  "payment_notification_inbox",
  "payment_admission",
  "payment_admission_commands",
  "payment_admission_reconciliation_events",
  "ai_budget",
  "ai_budget_daily",
  "ai_credit_accounts",
  "ai_credit_charges",
  "ai_credit_entries",
  "ai_credit_topups",
  "ai_model_attempt_daily",
  "ai_model_attempts",
  "ai_routing",
  "ai_usage_daily",
  "ai_user_model_attempt_daily",
  "ai_user_usage_daily",
  "chat_requests",
  "citygo_migration_lock",
  "citygo_migrations",
  "knowledge_sources",
  // Retirement must not erase receipt duties, delivery contacts or evidence.
  "npd_receipt_commands",
  "npd_receipt_evidence",
  "npd_receipt_tasks",
  "npd_refund_observations",
  "payment_topup_orders",
  "quests",
  "generated_artifacts",
] as const;
// Deliberate FK order. Housing revisions/commands cascade only from their brief,
// never from users or threads (which would also cascade accounting attempts).
const erasedTables = [
  "sessions",
  "user_credentials",
  "messages",
  "agent_handoffs",
  "r1_housing_briefs",
  "xp_events",
  "user_quests",
  "relocation_plans",
  "questionnaire_answers",
  "relocation_profiles",
  "ai_consents",
  "consent_events",
  "analytics_events",
] as const;

type Options = { expectedUserCount?: number; maintenanceConfirmed?: boolean };
export type ClosedAccountRestartPlan = {
  operation: "closed-account-restart-plan";
  dryRun: true;
  accountsDeleted: 0;
  accountCount: number;
  expectedUserCount: number | null;
  snapshotFingerprint: string;
  bootstrapCompleted: boolean;
  counts: Record<string, number>;
  blockers: AccountResetBlocker[];
  retained: string[];
};
export type ClosedAccountRestartInput = {
  expectedUserCount: number;
  expectedSnapshotFingerprint: string;
  backupReceiptSha256: string;
  maintenanceConfirmed: true;
  servicesStoppedConfirmed: true;
  retainedAuditsReviewed: true;
  passwordHash: string;
};
export type ClosedAccountRestartReceipt = {
  operation: "closed-account-restart";
  operationId: string;
  dryRun: false;
  accountsRetired: number;
  accountsDeleted: 0;
  admin: { username: "admin"; role: "super_admin"; mustChangePassword: true };
  accountingPreserved: true;
  publicIngressMayOpen: false;
};
type Snapshot = {
  values: Map<string, string[]>;
  counts: Record<string, number>;
  fingerprint: string;
};

function refuse(message: string, status = 409): never {
  throw new DomainError(status, message);
}
function validCount(value: number | undefined) {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0 || value > 1000)
  )
    refuse("Инструмент ограничен 0–1000 тестовыми аккаунтами", 400);
}
const hex = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

async function lockedSnapshot(
  tx: Sql,
): Promise<{ snapshot: Snapshot; bootstrapCompleted: boolean }> {
  await tx.exec(
    "set local lock_timeout='3s'; set local statement_timeout='10s'",
  );
  const state = (
    await tx.query<{ bootstrap_completed: boolean }>(
      "select bootstrap_completed from account_security_state where id=1 for update",
    )
  ).rows[0];
  if (!state) refuse("Хранилище аккаунтов не готово", 503);
  // Singleton -> users -> remaining tables. Offline maintenance is mandatory:
  // existing runtime writers do not all check deleted status or share one lock.
  await tx.exec("lock table public.users in share row exclusive mode");
  const inventory = (
    await tx.query<{ tablename: string }>(
      "select tablename from pg_catalog.pg_tables where schemaname='public' order by tablename",
    )
  ).rows.map((row) => row.tablename);
  if (JSON.stringify(inventory) !== JSON.stringify([...tables].sort()))
    refuse("Состав таблиц изменился; очистка требует нового ревью");
  await tx.exec(
    `lock table ${tables
      .filter((name) => name !== "users" && name !== "account_security_state")
      .map((name) => `public.${name}`)
      .join(",")} in share row exclusive mode`,
  );
  await tx.query("select id from users order by id for update");
  const snapshot = await takeSnapshot(tx);
  if (snapshot.counts.payment_admission !== 1)
    refuse("Состояние допуска оплаты не готово", 503);
  if (snapshot.counts.users! > 1000)
    refuse("Слишком много аккаунтов для закрытого тестового перехода");
  return { snapshot, bootstrapCompleted: state.bootstrap_completed };
}

async function tableValues(tx: Sql, name: string) {
  // name only comes from a static, reviewed inventory. Bound memory and work;
  // this is intentionally not a bulk production-data eraser.
  const stats = (
    await tx.query<{ count: number; bytes: string }>(
      `select count(*)::int as count,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::text as bytes from public.${name} t`,
    )
  ).rows[0]!;
  if (stats.count > 10000 || Number(stats.bytes) > 8_388_608)
    refuse("Объём данных превышает границы тестового инструмента");
  return (
    await tx.query<{ value: string }>(
      `select to_jsonb(t)::text as value from public.${name} t order by to_jsonb(t)::text`,
    )
  ).rows.map((row) => row.value);
}

async function takeSnapshot(tx: Sql): Promise<Snapshot> {
  const values = new Map<string, string[]>(),
    counts: Record<string, number> = {};
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of tables) {
    const rows = await tableValues(tx, name);
    counts[name] = rows.length;
    for (const row of rows) bytes += Buffer.byteLength(row);
    if (bytes > 33_554_432)
      refuse("Объём снимка превышает границы тестового инструмента");
    values.set(name, rows);
    hash.update(JSON.stringify([name, rows]));
  }
  // Bind the approval to actual column/FK definitions, not merely row counts.
  const schema = await tx.query<{ value: string }>(
    `select c.relname||':'||a.attname||':'||pg_catalog.format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||a.attidentity::text||':'||a.attgenerated::text||':'||coalesce(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'') as value
     from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
     where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
     order by c.relname,a.attnum`,
  );
  const constraints = await tx.query<{ value: string }>(
    `select c.relname||':'||k.conname||':'||pg_catalog.pg_get_constraintdef(k.oid) as value
     from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
     order by c.relname,k.conname`,
  );
  const indexes = await tx.query<{ value: string }>(
    "select tablename||':'||indexname||':'||indexdef as value from pg_catalog.pg_indexes where schemaname='public' order by tablename,indexname",
  );
  const triggers = await tx.query<{ value: string }>(
    `select c.relname||':'||t.tgname||':'||t.tgenabled::text||':'||pg_catalog.pg_get_triggerdef(t.oid) as value
     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`,
  );
  const functions = await tx.query<{ value: string }>(
    `select pg_catalog.pg_get_functiondef(p.oid) as value from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prokind in ('f','p') order by p.proname,p.oid`,
  );
  const views = await tx.query<{ value: string }>(
    "select viewname||':'||definition as value from pg_catalog.pg_views where schemaname='public' order by viewname",
  );
  hash.update(
    JSON.stringify([
      schema.rows,
      constraints.rows,
      indexes.rows,
      triggers.rows,
      functions.rows,
      views.rows,
    ]),
  );
  return { values, counts, fingerprint: hash.digest("hex") };
}

async function inspect(tx: Sql, options: Options) {
  const { snapshot, bootstrapCompleted } = await lockedSnapshot(tx);
  const blockers: AccountResetBlocker[] = [];
  // Private display metadata has no erasure authorization in these legacy tools.
  // A cleared title still retains its CAS evidence and needs separate review.
  if (snapshot.counts.conversation_titles)
    blockers.push({
      code: "CONVERSATION_TITLES_REQUIRE_REVIEW",
      count: snapshot.counts.conversation_titles,
    });
  if (
    snapshot.counts.human_support_requests ||
    snapshot.counts.human_support_replies
  )
    blockers.push({
      code: "HUMAN_SUPPORT_HISTORY_REQUIRES_REVIEW",
      count:
        (snapshot.counts.human_support_requests ?? 0) +
        (snapshot.counts.human_support_replies ?? 0),
    });
  if (bootstrapCompleted)
    blockers.push({ code: "BOOTSTRAP_ALREADY_COMPLETED", count: 1 });
  if (options.expectedUserCount === undefined)
    blockers.push({ code: "EXPECTED_USER_COUNT_NOT_PINNED", count: 1 });
  else if (options.expectedUserCount !== snapshot.counts.users)
    blockers.push({ code: "EXPECTED_USER_COUNT_MISMATCH", count: 1 });
  if (options.maintenanceConfirmed !== true)
    blockers.push({ code: "MAINTENANCE_NOT_CONFIRMED", count: 1 });
  // Verification identities and recipient/IP anti-abuse history are not an
  // account-reset retention policy. Preserve them and refuse ANY such history;
  // do not silently make old erasure authorization apply to the new tables.
  const verificationHistoryCount = [
    "service_consent_events",
    "account_email_verifications",
    "email_registrations",
    "email_registration_rate_events",
  ].reduce((total, name) => total + snapshot.counts[name]!, 0);
  if (verificationHistoryCount)
    blockers.push({
      code: "EMAIL_REGISTRATION_HISTORY_REQUIRES_REVIEW",
      count: verificationHistoryCount,
    });
  if (
    snapshot.counts.personal_plan_items ||
    snapshot.counts.personal_plan_checklists ||
    snapshot.counts.personal_plan_item_history
  )
    blockers.push({
      code: "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW",
      count:
        snapshot.counts.personal_plan_items! +
        snapshot.counts.personal_plan_checklists! +
        snapshot.counts.personal_plan_item_history!,
    });
  if (snapshot.counts.password_recovery_challenges)
    blockers.push({
      code: "PASSWORD_RECOVERY_HISTORY_REQUIRES_REVIEW",
      count: snapshot.counts.password_recovery_challenges,
    });
  if (snapshot.counts.account_email_confirmation_challenges)
    blockers.push({
      code: "ACCOUNT_EMAIL_CONFIRMATION_HISTORY_REQUIRES_REVIEW",
      count: snapshot.counts.account_email_confirmation_challenges,
    });
  const phoneContactHistoryCount =
    snapshot.counts.phone_contact_bindings! +
    snapshot.counts.phone_contact_changes!;
  if (phoneContactHistoryCount)
    blockers.push({
      code: "PHONE_CONTACT_HISTORY_REQUIRES_REVIEW",
      count: phoneContactHistoryCount,
    });
  if (snapshot.counts.ai_request_consent_bases)
    blockers.push({
      code: "AI_CONSENT_BASIS_HISTORY_REQUIRES_REVIEW",
      count: snapshot.counts.ai_request_consent_bases,
    });
  if (snapshot.counts.ai_request_modes)
    blockers.push({
      code: "AI_REQUEST_MODE_HISTORY_REQUIRES_REVIEW",
      count: snapshot.counts.ai_request_modes,
    });
  const postpayHistoryCount = [
    "ai_postpay_attempts",
    "credit_postpay_liabilities",
    "credit_postpay_repayments",
  ].reduce((sum, name) => sum + snapshot.counts[name]!, 0);
  if (postpayHistoryCount)
    blockers.push({
      code: "POSTPAY_HISTORY_REQUIRES_REVIEW",
      count: postpayHistoryCount,
    });
  const gigachatHistoryCount =
    snapshot.counts.gigachat_request_fees! +
    snapshot.counts.gigachat_account_leases!;
  if (gigachatHistoryCount)
    blockers.push({
      code: "GIGACHAT_HISTORY_REQUIRES_REVIEW",
      count: gigachatHistoryCount,
    });
  const phoneHistoryCount = [
    "phone_verification_challenges",
    "phone_verification_sends",
    "phone_welcome_claims",
  ].reduce((total, name) => total + snapshot.counts[name]!, 0);
  const phoneBindingCount = (
    await tx.query<{ count: number }>(
      "select count(*)::int as count from phone_verification_control where identity_key_fingerprint is not null",
    )
  ).rows[0]!.count;
  if (phoneHistoryCount + phoneBindingCount)
    blockers.push({
      code: "PHONE_VERIFICATION_HISTORY_REQUIRES_REVIEW",
      count: phoneHistoryCount + phoneBindingCount,
    });
  const block = async (code: string, sql: string) => {
    const count = (await tx.query<{ count: number }>(sql)).rows[0]!.count;
    if (count) blockers.push({ code, count });
  };
  const admissionHistoryCount =
    snapshot.counts.payment_admission_commands! +
    snapshot.counts.payment_admission_reconciliation_events!;
  if (admissionHistoryCount)
    blockers.push({
      code: "PAYMENT_ADMISSION_HISTORY_PRESENT",
      count: admissionHistoryCount,
    });
  await block(
    "PAYMENT_ADMISSION_LINKED_OR_ACTIVE",
    `select count(*)::int as count from payment_admission where owner_user_id is not null
     or accepting_new_checkouts or mode<>'closed' or reconciliation_enabled
     or reconciliation_run_id is not null or reconciliation_run_revision is not null
     or reconciliation_run_until is not null`,
  );
  await block(
    "ACTIVE_CHAT_REQUESTS",
    "select count(*)::int as count from chat_requests where status='running'",
  );
  await block(
    "UNRELEASED_GENERATION_LEASES",
    "select count(*)::int as count from agent_threads where lease_token is not null or busy_until is not null",
  );
  await block(
    "HELD_CREDIT_BALANCES",
    "select count(*)::int as count from ai_credit_accounts where held_micros<>0",
  );
  // Retain historical debt/repayment identities, but never retire the login of
  // an account that still owes money. Repayment is a separate trusted workflow.
  await block(
    "OUTSTANDING_CREDIT_DEBT",
    `select count(*)::int as count from credit_charge_debts d where d.principal_micros>
     coalesce((select sum(r.amount_micros) from credit_debt_repayments r where r.debt_hold_id=d.hold_id),0)`,
  );
  await block(
    "PENDING_CREDIT_HOLDS",
    "select count(*)::int as count from ai_credit_entries h where h.kind='hold' and not exists(select 1 from ai_credit_entries r where r.hold_id=h.operation_id)",
  );
  await block(
    "UNRECONCILED_PROVIDER_CHARGES",
    "select count(*)::int as count from ai_credit_charges where receipt is null",
  );
  await block(
    "EXTERNAL_ARTIFACT_INVENTORY_REQUIRED",
    "select count(*)::int as count from generated_artifacts",
  );
  // No guessed JSON pruning. These producer-owned operational records are
  // retained unchanged and ALSO require explicit operator review at apply.
  await block(
    "UNREVIEWED_AUDIT_KIND",
    `select count(*)::int as count from audit_log where not (
    (entity_type='ai-routing' and action in ('ai-routing-initialized','ai-routing-changed'))
    or (entity_type='ai-budget' and action='ai-budget-changed')
    or (entity_type='ai-credit' and action in ('ai-credit-welcome-granted','ai-credit-cost-overrun')))`,
  );
  const plan: ClosedAccountRestartPlan = {
    operation: "closed-account-restart-plan",
    dryRun: true,
    accountsDeleted: 0,
    accountCount: snapshot.counts.users!,
    expectedUserCount: options.expectedUserCount ?? null,
    snapshotFingerprint: snapshot.fingerprint,
    bootstrapCompleted,
    counts: snapshot.counts,
    blockers,
    retained: [
      ...retainedTables,
      "audit_log",
      "accounting_user_and_thread_skeletons",
      "backups_and_external_storage",
    ],
  };
  return { plan, snapshot };
}

export class ClosedAccountRestart {
  constructor(private db: Database) {}

  async plan(options: Options = {}): Promise<ClosedAccountRestartPlan> {
    validCount(options.expectedUserCount);
    return this.db.transaction(async (tx) => (await inspect(tx, options)).plan);
  }

  async apply(
    input: ClosedAccountRestartInput,
  ): Promise<ClosedAccountRestartReceipt> {
    validCount(input.expectedUserCount);
    if (
      input.expectedUserCount === undefined ||
      !hex(input.expectedSnapshotFingerprint) ||
      !hex(input.backupReceiptSha256) ||
      input.maintenanceConfirmed !== true ||
      input.servicesStoppedConfirmed !== true ||
      input.retainedAuditsReviewed !== true ||
      typeof input.passwordHash !== "string" ||
      !input.passwordHash ||
      input.passwordHash.length > 2048
    )
      refuse(
        "Требуются точный снимок, резервная копия, просмотр аудита и подтверждённая остановка сервисов",
        400,
      );
    return this.db.transaction(async (tx) => {
      const { plan, snapshot } = await inspect(tx, input);
      if (plan.snapshotFingerprint !== input.expectedSnapshotFingerprint)
        refuse(
          "Данные изменились после dry-run; нужен новый снимок и проверка",
        );
      if (plan.blockers.length)
        refuse(
          "Закрытый переход заблокирован; проверьте dry-run без изменения данных",
        );
      for (const name of erasedTables)
        await tx.exec(`delete from public.${name}`);
      await tx.exec(
        "update agent_threads set context='{}'::jsonb,status='closed',lease_token=null,busy_until=null",
      );
      const users = (
        await tx.query<{ id: string }>("select id::text from users order by id")
      ).rows;
      for (const user of users)
        await tx.query(
          "update users set status='deleted',auth_subject=$2,username=null,role='user',must_change_password=false,updated_at=now() where id=$1",
          [user.id, `retired:${randomUUID()}`],
        );
      for (const name of retainedTables) {
        if (
          JSON.stringify(await tableValues(tx, name)) !==
          JSON.stringify(snapshot.values.get(name))
        )
          refuse(
            "Инвариант сохранения учёта нарушен; транзакция отменена",
            500,
          );
      }
      if (
        JSON.stringify(await tableValues(tx, "audit_log")) !==
        JSON.stringify(snapshot.values.get("audit_log"))
      )
        refuse("Исторический аудит изменился; транзакция отменена", 500);
      for (const name of [
        ...erasedTables,
        "r1_housing_commands",
        "r1_housing_brief_revisions",
      ])
        if ((await tableValues(tx, name)).length)
          refuse("Личные данные не очищены; транзакция отменена", 500);
      const remaining = (
        await tx.query<{ count: number }>(
          "select count(*)::int as count from users where status<>'deleted' or username is not null or role<>'user' or must_change_password or auth_subject not like 'retired:%'",
        )
      ).rows[0]!.count;
      if (remaining) refuse("Аккаунты не закрыты; транзакция отменена", 500);
      // Same transaction and locks as retirement, not a weaker public bootstrap.
      const admin = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject,username,role,must_change_password) values ($1,'admin','super_admin',true) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,'admin@citygo.invalid',$2)",
        [admin.id, input.passwordHash],
      );
      await tx.exec(
        "update account_security_state set bootstrap_completed=true where id=1",
      );
      const operationId = randomUUID();
      await tx.query(
        "insert into audit_log(action,entity_type,entity_id,payload) values ('closed-account-restart-completed','account-maintenance',$1,$2::jsonb)",
        [
          operationId,
          JSON.stringify({
            snapshotFingerprint: plan.snapshotFingerprint,
            backupReceiptSha256: input.backupReceiptSha256,
            accountsRetired: users.length,
            accountsDeleted: 0,
            accountingPreserved: true,
            retainedAuditsReviewed: true,
            administratorMustChangePassword: true,
            publicIngressMayOpen: false,
          }),
        ],
      );
      // Flush deferred FK/constraint-trigger effects before the last invariant
      // scans. There must be no further writes after this point: otherwise a
      // commit-time effect could invalidate accountingPreserved after checking.
      await tx.exec("set constraints all immediate");
      // Recheck AFTER the admin and receipt writes as well: an unexpected
      // trigger on those writes must not silently mutate accounting/history.
      for (const name of retainedTables)
        if (
          JSON.stringify(await tableValues(tx, name)) !==
          JSON.stringify(snapshot.values.get(name))
        )
          refuse("Итоговый учёт изменился; транзакция отменена", 500);
      const auditsAfter = await tableValues(tx, "audit_log");
      const priorAudits = auditsAfter.filter((value) => {
        const row = JSON.parse(value) as {
          entity_id: string;
          entity_type: string;
          action: string;
        };
        return !(
          row.entity_id === operationId &&
          row.entity_type === "account-maintenance" &&
          row.action === "closed-account-restart-completed"
        );
      });
      if (
        auditsAfter.length !== priorAudits.length + 1 ||
        JSON.stringify(priorAudits) !==
          JSON.stringify(snapshot.values.get("audit_log"))
      )
        refuse(
          "Итоговый исторический аудит изменился; транзакция отменена",
          500,
        );
      const activeAdmin = (
        await tx.query<{ ok: boolean }>(
          `select (u.status='active' and u.username='admin' and u.role='super_admin' and u.must_change_password
          and c.email='admin@citygo.invalid' and c.password_hash=$2) as ok
         from users u join user_credentials c on c.user_id=u.id where u.id=$1`,
          [admin.id, input.passwordHash],
        )
      ).rows[0];
      if (
        activeAdmin?.ok !== true ||
        (await tableValues(tx, "user_credentials")).length !== 1
      )
        refuse(
          "Первичный аккаунт не прошёл итоговую проверку; транзакция отменена",
          500,
        );
      const finalState = (
        await tx.query<{
          invalid: number;
          users: number;
          threads: number;
          completed: boolean;
        }>(
          `select
         (select count(*)::int from users where id<>$1 and (status<>'deleted' or username is not null or role<>'user' or must_change_password or auth_subject not like 'retired:%')) as invalid,
         (select count(*)::int from users) as users,
         (select count(*)::int from agent_threads where context<>'{}'::jsonb or status<>'closed' or lease_token is not null or busy_until is not null) as threads,
         (select bootstrap_completed from account_security_state where id=1) as completed`,
          [admin.id],
        )
      ).rows[0]!;
      if (
        finalState.invalid ||
        finalState.users !== users.length + 1 ||
        finalState.threads ||
        !finalState.completed
      )
        refuse(
          "Итоговые аккаунты или диалоги изменились; транзакция отменена",
          500,
        );
      for (const name of [
        ...erasedTables.filter((name) => name !== "user_credentials"),
        "r1_housing_commands",
        "r1_housing_brief_revisions",
      ])
        if ((await tableValues(tx, name)).length)
          refuse(
            "Личные данные восстановлены побочным эффектом; транзакция отменена",
            500,
          );
      return {
        operation: "closed-account-restart",
        operationId,
        dryRun: false,
        accountsRetired: users.length,
        accountsDeleted: 0,
        admin: {
          username: "admin",
          role: "super_admin",
          mustChangePassword: true,
        },
        accountingPreserved: true,
        publicIngressMayOpen: false,
      };
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

// Explicit destructive TEST-PILOT transition. Never called by runtime startup,
// registration, migrations, HTTP, or the accounting-preserving restart tool.
// This inventory is deliberately not discovered into a deletion list.
const tables = [
  "service_consent_events",
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
// These reviewed FK children may participate in the single TRUNCATE only when
// all are empty under the snapshot's table locks. Any receipt obligation,
// contact, correction or delivery history blocks this TEST-only eraser.
const protectedNpd = [
  "npd_receipt_commands",
  "npd_receipt_evidence",
  "npd_receipt_tasks",
  "npd_refund_observations",
] as const;
const protectedRefunds = [
  "credit_refund_allocations",
  "payment_refund_events",
  "payment_refunds",
] as const;
// Even an untrusted wake-up hint belongs to a bound external payment/refund.
// Do not erase pending reconciliation or its completion history in this tool.
const protectedNotifications = ["payment_notification_inbox"] as const;
// Even fully repaid debt is immutable financial history, not resettable test
// data. These FK children may join TRUNCATE only while empty under table locks.
const protectedDebt = [
  "credit_charge_debts",
  "credit_debt_repayments",
] as const;
// Admission history has immutable TRUNCATE guards, even when empty. Its
// singleton/configuration is retained verbatim, never reset with test money.
const protectedAdmission = [
  "payment_admission",
  "payment_admission_commands",
  "payment_admission_reconciliation_events",
] as const;
const protectedEmpty = [
  // User-chosen steps and their tombstones need a separate erasure review.
  "personal_plan_items",
  ...protectedNpd,
  ...protectedRefunds,
  ...protectedNotifications,
  ...protectedDebt,
] as const;
const preserved = [
  "service_consent_events",
  "phone_verification_challenges",
  "phone_verification_control",
  "phone_verification_sends",
  "phone_welcome_claims",
  "phone_contact_bindings",
  "phone_contact_changes",
  "ai_request_modes",
  // No retention/anti-abuse deletion is authorized by the old TEST reset.
  "password_recovery_challenges",
  "account_email_confirmation_challenges",
  "account_email_verifications",
  "email_registrations",
  "email_registration_rate_events",
  "citygo_migration_lock",
  "citygo_migrations",
  "quests",
  "ai_routing",
  ...protectedEmpty,
  ...protectedAdmission,
] as const;
const erased = [
  "agent_handoffs",
  "agent_threads",
  "ai_budget_daily",
  "ai_consents",
  "ai_credit_accounts",
  "ai_credit_charges",
  "ai_credit_entries",
  "ai_credit_topups",
  "ai_model_attempt_daily",
  "ai_model_attempts",
  "ai_usage_daily",
  "ai_user_model_attempt_daily",
  "ai_user_usage_daily",
  "analytics_events",
  "audit_log",
  "chat_requests",
  "consent_events",
  "credit_hold_allocations",
  "credit_source_lots",
  "generated_artifacts",
  "knowledge_sources",
  "messages",
  "payment_topup_orders",
  "questionnaire_answers",
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

type Options = { expectedUserCount?: number; maintenanceConfirmed?: boolean };
export type FreshAccountResetPlan = {
  operation: "fresh-account-reset-plan";
  dryRun: true;
  accountsDeleted: 0;
  accountCount: number;
  expectedUserCount: number | null;
  snapshotFingerprint: string;
  bootstrapCompleted: boolean;
  counts: Record<string, number>;
  blockers: { code: string; count: number }[];
  erasedTables: string[];
  preservedTables: string[];
  accountingPreserved: false;
  externalObjectsDeleted: false;
};
export type FreshAccountResetInput = {
  expectedUserCount: number;
  expectedSnapshotFingerprint: string;
  backupReceiptSha256: string;
  maintenanceConfirmed: true;
  servicesStoppedConfirmed: true;
  destructiveResetConfirmed: true;
  passwordHash: string;
};
export type FreshAccountResetReceipt = {
  operation: "fresh-account-reset";
  operationId: string;
  dryRun: false;
  accountsDeleted: number;
  admin: { username: "admin"; role: "super_admin"; mustChangePassword: true };
  accountingPreserved: false;
  knowledgeEmpty: true;
  operatorBudgetEnabled: false;
  externalObjectsDeleted: false;
  publicIngressMayOpen: false;
};
type Snapshot = {
  values: Map<string, string[]>;
  counts: Record<string, number>;
  schema: string;
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
    refuse("Полный сброс ограничен 0–1000 тестовыми аккаунтами", 400);
}
const hex = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function inventory(tx: Sql) {
  const actual = (
    await tx.query<{ tablename: string }>(
      "select tablename from pg_catalog.pg_tables where schemaname='public' order by tablename",
    )
  ).rows.map((row) => row.tablename);
  if (JSON.stringify(actual) !== JSON.stringify([...tables].sort()))
    refuse("Состав таблиц изменился; полный сброс требует нового ревью");
  const unreviewedStorage = (
    await tx.query<{ count: number }>(
      "select count(*)::int as count from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('m','f')",
    )
  ).rows[0]!.count;
  if (unreviewedStorage)
    refuse(
      "Найдено непроверенное хранилище данных; полный сброс требует нового ревью",
    );
}
async function rows(tx: Sql, name: (typeof tables)[number]) {
  const stats = (
    await tx.query<{ count: number; bytes: string }>(
      `select count(*)::int as count,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::text as bytes from public.${name} t`,
    )
  ).rows[0]!;
  if (stats.count > 10000 || Number(stats.bytes) > 8_388_608)
    refuse("Объём данных превышает границы полного тестового сброса");
  return (
    await tx.query<{ value: string }>(
      `select to_jsonb(t)::text as value from public.${name} t order by to_jsonb(t)::text`,
    )
  ).rows.map((row) => row.value);
}
async function schemaSnapshot(tx: Sql) {
  const columns = await tx.query(
    `select c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) as type,
       a.attnotnull,a.attidentity::text,a.attgenerated::text,
       pg_catalog.pg_get_expr(d.adbin,d.adrelid) as default_value
     from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
     where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
     order by c.relname,a.attnum`,
  );
  const constraints = await tx.query(
    `select c.relname,k.conname,pg_catalog.pg_get_constraintdef(k.oid) as definition
     from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
     order by c.relname,k.conname`,
  );
  const indexes = await tx.query(
    "select tablename,indexname,indexdef from pg_catalog.pg_indexes where schemaname='public' order by tablename,indexname",
  );
  const triggers = await tx.query(
    `select c.relname,t.tgname,t.tgenabled::text,pg_catalog.pg_get_triggerdef(t.oid) as definition
     from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`,
  );
  const functions = await tx.query(
    `select pg_catalog.pg_get_functiondef(p.oid) as definition from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.prokind in ('f','p') order by p.proname,p.oid`,
  );
  const views = await tx.query(
    "select viewname,definition from pg_catalog.pg_views where schemaname='public' order by viewname",
  );
  // ACL and ownership must survive too; no schema drop/recreate is involved.
  const permissions = await tx.query(
    `select c.relname,c.relkind,r.rolname as owner,c.relacl::text from pg_catalog.pg_class c
     join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     join pg_catalog.pg_roles r on r.oid=c.relowner where n.nspname='public'
     order by c.relname,c.relkind`,
  );
  const schemaPermissions = await tx.query(
    "select n.nspname,r.rolname as owner,n.nspacl::text from pg_catalog.pg_namespace n join pg_catalog.pg_roles r on r.oid=n.nspowner where n.nspname='public'",
  );
  const functionPermissions = await tx.query(
    `select p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
      r.rolname as owner,p.proacl::text from pg_catalog.pg_proc p
     join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     join pg_catalog.pg_roles r on r.oid=p.proowner where n.nspname='public'
     order by p.proname,p.oid`,
  );
  const defaultPermissions = await tx.query(
    `select r.rolname as owner,d.defaclobjtype,d.defaclacl::text
     from pg_catalog.pg_default_acl d join pg_catalog.pg_roles r on r.oid=d.defaclrole
     where d.defaclnamespace=0 or d.defaclnamespace='public'::regnamespace
     order by r.rolname,d.defaclnamespace,d.defaclobjtype`,
  );
  return JSON.stringify([
    columns.rows,
    constraints.rows,
    indexes.rows,
    triggers.rows,
    functions.rows,
    views.rows,
    permissions.rows,
    schemaPermissions.rows,
    functionPermissions.rows,
    defaultPermissions.rows,
  ]);
}
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
  await tx.exec("lock table public.users in share row exclusive mode");
  await inventory(tx);
  await tx.exec(
    `lock table ${tables
      .filter((name) => name !== "users" && name !== "account_security_state")
      .map((name) => `public.${name}`)
      .join(",")} in share row exclusive mode`,
  );
  const values = new Map<string, string[]>(),
    counts: Record<string, number> = {};
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of tables) {
    const content = await rows(tx, name);
    for (const row of content) bytes += Buffer.byteLength(row);
    if (bytes > 33_554_432)
      refuse("Объём снимка превышает границы полного тестового сброса");
    values.set(name, content);
    counts[name] = content.length;
    hash.update(JSON.stringify([name, content]));
  }
  validCount(counts.users);
  if (
    counts.account_security_state !== 1 ||
    counts.ai_budget !== 1 ||
    counts.payment_admission !== 1
  )
    refuse("Служебное состояние аккаунтов или бюджета не готово", 503);
  const schema = await schemaSnapshot(tx);
  hash.update(schema);
  return {
    snapshot: { values, counts, schema, fingerprint: hash.digest("hex") },
    bootstrapCompleted: state.bootstrap_completed,
  };
}
async function inspect(tx: Sql, options: Options) {
  const { snapshot, bootstrapCompleted } = await lockedSnapshot(tx);
  const blockers: FreshAccountResetPlan["blockers"] = [];
  if (options.expectedUserCount === undefined)
    blockers.push({ code: "EXPECTED_USER_COUNT_NOT_PINNED", count: 1 });
  else if (options.expectedUserCount !== snapshot.counts.users)
    blockers.push({ code: "EXPECTED_USER_COUNT_MISMATCH", count: 1 });
  if (options.maintenanceConfirmed !== true)
    blockers.push({ code: "MAINTENANCE_NOT_CONFIRMED", count: 1 });
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
  if (snapshot.counts.personal_plan_items)
    blockers.push({
      code: "PERSONAL_PLAN_HISTORY_REQUIRES_REVIEW",
      count: snapshot.counts.personal_plan_items,
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
  if (snapshot.counts.ai_request_modes)
    blockers.push({
      code: "AI_REQUEST_MODE_HISTORY_REQUIRES_REVIEW",
      count: snapshot.counts.ai_request_modes,
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
  const npdHistoryCount = protectedNpd.reduce(
    (count, name) => count + snapshot.counts[name]!,
    0,
  );
  if (npdHistoryCount)
    blockers.push({
      code: "NPD_RECEIPT_HISTORY_PRESENT",
      count: npdHistoryCount,
    });
  const refundHistoryCount = protectedRefunds.reduce(
    (count, name) => count + snapshot.counts[name]!,
    0,
  );
  if (refundHistoryCount)
    blockers.push({
      code: "REFUND_FINANCIAL_HISTORY_PRESENT",
      count: refundHistoryCount,
    });
  const notificationHistoryCount = protectedNotifications.reduce(
    (count, name) => count + snapshot.counts[name]!,
    0,
  );
  if (notificationHistoryCount)
    blockers.push({
      code: "PAYMENT_NOTIFICATION_HISTORY_PRESENT",
      count: notificationHistoryCount,
    });
  const debtHistoryCount = protectedDebt.reduce(
    (count, name) => count + snapshot.counts[name]!,
    0,
  );
  if (debtHistoryCount)
    blockers.push({
      code: "CREDIT_DEBT_HISTORY_PRESENT",
      count: debtHistoryCount,
    });
  const admissionHistoryCount =
    snapshot.counts.payment_admission_commands! +
    snapshot.counts.payment_admission_reconciliation_events!;
  if (admissionHistoryCount)
    blockers.push({
      code: "PAYMENT_ADMISSION_HISTORY_PRESENT",
      count: admissionHistoryCount,
    });
  for (const [code, sql] of [
    [
      "PAYMENT_ADMISSION_LINKED_OR_ACTIVE",
      `select count(*)::int as count from payment_admission where owner_user_id is not null
       or accepting_new_checkouts or mode<>'closed' or reconciliation_enabled
       or reconciliation_run_id is not null or reconciliation_run_revision is not null
       or reconciliation_run_until is not null`,
    ],
    [
      "FRESH_RESET_ALREADY_COMPLETED",
      "select count(*)::int as count from audit_log where action='fresh-account-reset-completed' and entity_type='account-maintenance'",
    ],
    [
      "ACTIVE_CHAT_REQUESTS",
      "select count(*)::int as count from chat_requests where status='running'",
    ],
    [
      "UNRELEASED_GENERATION_LEASES",
      "select count(*)::int as count from agent_threads where lease_token is not null or busy_until is not null",
    ],
  ]) {
    const count = (await tx.query<{ count: number }>(sql!)).rows[0]!.count;
    if (count) blockers.push({ code: code!, count });
  }
  const plan: FreshAccountResetPlan = {
    operation: "fresh-account-reset-plan",
    dryRun: true,
    accountsDeleted: 0,
    accountCount: snapshot.counts.users!,
    expectedUserCount: options.expectedUserCount ?? null,
    snapshotFingerprint: snapshot.fingerprint,
    bootstrapCompleted,
    counts: snapshot.counts,
    blockers,
    erasedTables: [...erased],
    preservedTables: [...preserved],
    accountingPreserved: false,
    externalObjectsDeleted: false,
  };
  return { plan, snapshot };
}

export class FreshAccountReset {
  constructor(private db: Database) {}

  async plan(options: Options = {}): Promise<FreshAccountResetPlan> {
    validCount(options.expectedUserCount);
    return this.db.transaction(async (tx) => (await inspect(tx, options)).plan);
  }

  async apply(
    input: FreshAccountResetInput,
  ): Promise<FreshAccountResetReceipt> {
    validCount(input.expectedUserCount);
    if (
      input.expectedUserCount === undefined ||
      !hex(input.expectedSnapshotFingerprint) ||
      !hex(input.backupReceiptSha256) ||
      input.maintenanceConfirmed !== true ||
      input.servicesStoppedConfirmed !== true ||
      input.destructiveResetConfirmed !== true ||
      typeof input.passwordHash !== "string" ||
      !input.passwordHash ||
      input.passwordHash.length > 2048
    )
      refuse(
        "Требуются точный снимок, резервная копия, остановка сервисов и явное подтверждение полного удаления",
        400,
      );
    return this.db.transaction(async (tx) => {
      const { plan, snapshot } = await inspect(tx, input);
      if (plan.snapshotFingerprint !== input.expectedSnapshotFingerprint)
        refuse("Данные изменились после dry-run; нужен новый снимок");
      if (plan.blockers.length)
        refuse("Полный тестовый сброс заблокирован; проверьте dry-run");
      // This retained FK child may join the old parent TRUNCATE only while
      // provably empty. The locked snapshot and this immediate recheck both
      // reject ANY accepted mode evidence; no new parent deletion is added.
      if (
        snapshot.counts.ai_request_modes !== 0 ||
        (await tx.query("select 1 from ai_request_modes limit 1")).rows.length
      )
        refuse("История режимов ИИ требует отдельного сохранения и ревью");
      // Truncate only reviewed child tables. Even EMPTY admission history has a
      // users FK and immutable TRUNCATE guard; it must never join this command.
      // Retained phone evidence also references credit entries. Even when empty
      // it must never join TRUNCATE: delete the already-authorized old financial
      // parents separately, only after all history/owner blockers were checked.
      // No CASCADE, schema drop, sequence restart, role changes or migration edits.
      await tx.exec(
        `truncate table ${[
          ...erased.filter(
            (name) =>
              !["users", "ai_credit_entries", "ai_credit_accounts"].includes(
                name,
              ),
          ),
          ...protectedEmpty,
          "ai_request_modes",
        ]
          .map((name) => `public.${name}`)
          .join(",")}`,
      );
      await tx.exec("delete from public.ai_credit_entries");
      await tx.exec("delete from public.ai_credit_accounts");
      await tx.exec("delete from public.users");
      await tx.exec(
        "update ai_budget set enabled=false,total_reserved_micros=0,user_daily_limit_micros=null,revision=revision+1 where id=1",
      );
      // The sticky test/live boundary can only be cleared while every account,
      // attempt and payment has been erased and the operator budget is disabled.
      // The DB trigger verifies those facts; runtime cannot clear the marker.
      await tx.exec(
        "update account_security_state set test_payments_seen=false,real_ai_admitted=false where id=1",
      );
      const authSubject = randomUUID();
      const admin = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject,username,role,must_change_password) values ($1,'admin','super_admin',true) returning id::text",
          [authSubject],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,'admin@citygo.invalid',$2)",
        [admin.id, input.passwordHash],
      );
      // An existing bootstrap is replaced ONLY inside this explicitly destructive
      // transition. Its durable flag is never temporarily reset to false.
      await tx.exec(
        "update account_security_state set bootstrap_completed=true where id=1",
      );
      const operationId = randomUUID();
      const auditPayload = {
        snapshotFingerprint: plan.snapshotFingerprint,
        backupReceiptSha256: input.backupReceiptSha256,
        accountsDeleted: plan.accountCount,
        accountingPreserved: false,
        knowledgeEmpty: true,
        operatorBudgetEnabled: false,
        externalObjectsDeleted: false,
        administratorMustChangePassword: true,
        publicIngressMayOpen: false,
      };
      await tx.query(
        "insert into audit_log(action,entity_type,entity_id,payload) values ('fresh-account-reset-completed','account-maintenance',$1,$2::jsonb)",
        [operationId, JSON.stringify(auditPayload)],
      );
      await tx.exec("set constraints all immediate");
      // No further writes after deferred effects are flushed. Unexpected triggers
      // cannot silently resurrect history, change catalogues or grant money.
      await inventory(tx);
      if ((await schemaSnapshot(tx)) !== snapshot.schema)
        refuse("Схема или права изменились; транзакция отменена", 500);
      for (const name of preserved)
        if (
          JSON.stringify(await rows(tx, name)) !==
          JSON.stringify(snapshot.values.get(name))
        )
          refuse(
            "История миграций или конфигурация изменились; транзакция отменена",
            500,
          );
      const budgetBefore = snapshot.values
        .get("ai_budget")!
        .map((row) => JSON.parse(row) as Record<string, unknown>);
      const expectedBudget = budgetBefore.map((row) => ({
        ...row,
        enabled: false,
        total_reserved_micros: 0,
        user_daily_limit_micros: null,
        revision: Number(row.revision) + 1,
      }));
      const budgetAfter = (await rows(tx, "ai_budget")).map(
        (row) => JSON.parse(row) as Record<string, unknown>,
      );
      if (canonical(budgetAfter) !== canonical(expectedBudget))
        refuse("Бюджет оператора не закрыт; транзакция отменена", 500);
      for (const name of erased.filter(
        (name) => !["users", "user_credentials", "audit_log"].includes(name),
      ))
        if ((await rows(tx, name)).length)
          refuse(
            "История восстановлена побочным эффектом; транзакция отменена",
            500,
          );
      const newUsers = await rows(tx, "users"),
        credentials = await rows(tx, "user_credentials"),
        audits = await rows(tx, "audit_log");
      const user = newUsers[0]
        ? (JSON.parse(newUsers[0]) as Record<string, unknown>)
        : null;
      const credential = credentials[0]
        ? (JSON.parse(credentials[0]) as Record<string, unknown>)
        : null;
      const audit = audits[0]
        ? (JSON.parse(audits[0]) as Record<string, unknown>)
        : null;
      const finalState = await rows(tx, "account_security_state");
      if (
        newUsers.length !== 1 ||
        credentials.length !== 1 ||
        audits.length !== 1 ||
        String(user?.id) !== admin.id ||
        user?.status !== "active" ||
        user?.username !== "admin" ||
        user?.role !== "super_admin" ||
        user?.must_change_password !== true ||
        user?.auth_subject !== authSubject ||
        String(credential?.user_id) !== admin.id ||
        credential?.email !== "admin@citygo.invalid" ||
        credential?.password_hash !== input.passwordHash ||
        audit?.entity_id !== operationId ||
        audit?.action !== "fresh-account-reset-completed" ||
        audit?.entity_type !== "account-maintenance" ||
        audit?.actor_user_id !== null ||
        canonical(audit?.payload) !== canonical(auditPayload) ||
        finalState.length !== 1 ||
        JSON.parse(finalState[0]!).bootstrap_completed !== true ||
        JSON.parse(finalState[0]!).test_payments_seen !== false ||
        JSON.parse(finalState[0]!).real_ai_admitted !== false
      )
        refuse(
          "Первичный аккаунт или квитанция не прошли проверку; транзакция отменена",
          500,
        );
      return {
        operation: "fresh-account-reset",
        operationId,
        dryRun: false,
        accountsDeleted: plan.accountCount,
        admin: {
          username: "admin",
          role: "super_admin",
          mustChangePassword: true,
        },
        accountingPreserved: false,
        knowledgeEmpty: true,
        operatorBudgetEnabled: false,
        externalObjectsDeleted: false,
        publicIngressMayOpen: false,
      };
    });
  }
}

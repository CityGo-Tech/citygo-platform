// Operator-only CLI. Never import this module from server.ts/dev.ts or
// expose it as HTTP. It deliberately loads no .env files. The legacy reset flag
// is unavailable; closed account retirement is a distinct, explicit operation.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  AccountAccess,
  AccountReset,
  ClosedAccountRestart,
  FreshAccountReset,
  connectDatabase,
  DomainError,
} from "@citygo/db";
import { hashPassword } from "./auth.js";

function refuse(message: string): never {
  throw new DomainError(400, message);
}
const controlledSearchPath = "pg_catalog,public,pg_temp";

// Pure validation/preparation for tests and this operator CLI only. The returned
// connectionString contains credentials and must NEVER be logged or returned by
// accountMaintenance. It is consumed only by connectDatabase below.
export function prepareAccountMaintenanceConnection(
  rawUrl: string,
  expectedTarget: string,
) {
  const canonical = (value: string, expected: boolean) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return refuse("Некорректное описание целевой БД");
    }
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[0-9a-fA-F:.]+\])$/.test(
        url.hostname,
      ) ||
      !/^\/[a-z][a-z0-9_]{0,62}$/.test(url.pathname) ||
      url.hash ||
      url.search ||
      (expected && (url.username || url.password))
    )
      refuse(
        "Требуется PostgreSQL без query-параметров и точная цель без секретов в аргументах",
      );
    return `postgresql://${url.hostname}:${url.port || "5432"}${url.pathname}`;
  };
  const target = canonical(expectedTarget, true);
  if (canonical(rawUrl, false) !== target)
    refuse("Подключение не совпадает с явно выбранной БД");
  // Disallow every input query parameter, then add only a fixed startup option.
  // A one-off SET would protect one arbitrary pooled connection, not all of them.
  const connectionUrl = new URL(rawUrl);
  // PGPORT must not replace the canonical implicit PostgreSQL port.
  connectionUrl.port = connectionUrl.port || "5432";
  connectionUrl.searchParams.set(
    "options",
    `-csearch_path=${controlledSearchPath}`,
  );
  return { target, connectionString: connectionUrl.toString() };
}

export async function accountMaintenance(
  args: string[],
  environment: Record<string, string | undefined>,
) {
  if (args.length === 1 && args[0] === "--help")
    return {
      tool: "CityGo account maintenance (operator-only, no automatic startup)",
      connection:
        "CITYGO_ACCOUNT_DATABASE_URL, supplied only by the operator; no .env is loaded",
      dryRun:
        "Default: --expected-target=postgresql://HOST:PORT/DATABASE --expected-environment=production --expect-users=5",
      bootstrap:
        "--bootstrap-admin --apply --maintenance-confirmed --expect-users=0; also CITYGO_ACCOUNT_BOOTSTRAP_CLOSED=true after verifying closed ingress",
      restart:
        "--restart-accounts (dry-run); apply additionally requires --apply --expect-users=N --expected-snapshot=SHA256 --backup-receipt-sha256=SHA256 --maintenance-confirmed --services-stopped-confirmed --retained-audits-reviewed and CITYGO_ACCOUNT_BOOTSTRAP_CLOSED=true; declarations do not stop services, verify a backup or prove audits contain no personal data",
      freshStart:
        "--fresh-start (dry-run); DESTRUCTIVE apply requires --erase-test-history plus the exact snapshot, backup receipt, user count, stopped-service/closed-maintenance confirmations and CITYGO_ACCOUNT_BOOTSTRAP_CLOSED=true. Deletes test accounts, chats, financial history and knowledge; does not delete backups/external objects or open ingress.",
      reset:
        "--apply-reset is deliberately unavailable; accounting anonymization and erasure require a separately reviewed operator workflow",
    };
  if (args.includes("--apply-reset"))
    refuse(
      "Сброс не реализован: сначала требуется проверяемая анонимизация учёта расходов, аудит и отдельный план удаления",
    );
  const allowedFlags = new Set([
    "--bootstrap-admin",
    "--restart-accounts",
    "--fresh-start",
    "--erase-test-history",
    "--apply",
    "--maintenance-confirmed",
    "--services-stopped-confirmed",
    "--retained-audits-reviewed",
  ]);
  const allowedValues = new Set([
    "--expected-target",
    "--expected-environment",
    "--expect-users",
    "--expected-snapshot",
    "--backup-receipt-sha256",
  ]);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const arg of args) {
    const equal = arg.indexOf("=");
    if (equal === -1) {
      if (!allowedFlags.has(arg) || flags.has(arg))
        refuse("Неизвестный или повторённый параметр");
      flags.add(arg);
    } else {
      const key = arg.slice(0, equal);
      if (!allowedValues.has(key) || values.has(key))
        refuse("Неизвестный или повторённый параметр");
      values.set(key, arg.slice(equal + 1));
    }
  }
  const bootstrap = flags.has("--bootstrap-admin");
  const restart = flags.has("--restart-accounts");
  const fresh = flags.has("--fresh-start");
  if ([bootstrap, restart, fresh].filter(Boolean).length > 1)
    refuse("Первичный bootstrap и закрытый перезапуск аккаунтов несовместимы");
  if (flags.has("--apply") && !bootstrap && !restart && !fresh)
    refuse(
      "Изменения требуют явно выбранного первичного bootstrap или закрытого перезапуска аккаунтов; прежний сброс недоступен",
    );
  const expectedSnapshotFingerprint = values.get("--expected-snapshot");
  const backupReceiptSha256 = values.get("--backup-receipt-sha256");
  if (
    !restart &&
    !fresh &&
    (expectedSnapshotFingerprint !== undefined ||
      backupReceiptSha256 !== undefined ||
      flags.has("--services-stopped-confirmed") ||
      flags.has("--retained-audits-reviewed"))
  )
    refuse("Параметры закрытого перезапуска требуют --restart-accounts");
  if (flags.has("--erase-test-history") && !fresh)
    refuse("Удаление тестовой истории требует отдельного --fresh-start");
  if (fresh && flags.has("--retained-audits-reviewed"))
    refuse(
      "Fresh-start удаляет аудит, а не сохраняет его: выберите точную операцию",
    );
  for (const fingerprint of [expectedSnapshotFingerprint, backupReceiptSha256])
    if (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint))
      refuse("Требуется точный SHA-256 отпечаток из 64 строчных hex-символов");
  const actualEnvironment = environment.NODE_ENV;
  if (
    !["development", "test", "production"].includes(actualEnvironment ?? "") ||
    values.get("--expected-environment") !== actualEnvironment
  )
    refuse("Требуется точное явное подтверждение NODE_ENV");
  const expectedTarget = values.get("--expected-target");
  const rawUrl = environment.CITYGO_ACCOUNT_DATABASE_URL;
  if (!expectedTarget || !rawUrl)
    refuse("Оператор должен явно задать подключение и ожидаемую БД");
  const { target, connectionString } = prepareAccountMaintenanceConnection(
    rawUrl,
    expectedTarget,
  );
  const rawCount = values.get("--expect-users");
  if (rawCount !== undefined && !/^(0|[1-9]\d{0,3})$/.test(rawCount))
    refuse("Некорректное ожидаемое число аккаунтов");
  const expectedUserCount =
    rawCount === undefined ? undefined : Number(rawCount);
  if (expectedUserCount !== undefined && expectedUserCount > 1000)
    refuse("Инструмент ограничен небольшим тестовым контуром");
  if (
    bootstrap &&
    flags.has("--apply") &&
    (!flags.has("--maintenance-confirmed") ||
      expectedUserCount !== 0 ||
      environment.CITYGO_ACCOUNT_BOOTSTRAP_CLOSED !== "true")
  )
    refuse(
      "Bootstrap требует подтверждённого закрытого maintenance и ожидаемого числа аккаунтов 0",
    );
  if (
    restart &&
    flags.has("--apply") &&
    (!flags.has("--maintenance-confirmed") ||
      !flags.has("--services-stopped-confirmed") ||
      !flags.has("--retained-audits-reviewed") ||
      expectedUserCount === undefined ||
      expectedSnapshotFingerprint === undefined ||
      backupReceiptSha256 === undefined ||
      environment.CITYGO_ACCOUNT_BOOTSTRAP_CLOSED !== "true")
  )
    refuse(
      "Закрытый перезапуск требует закрытого maintenance, остановленных сервисов, проверки сохраняемого аудита, точного числа аккаунтов, snapshot и квитанции backup",
    );
  if (
    fresh &&
    flags.has("--apply") &&
    (!flags.has("--erase-test-history") ||
      !flags.has("--maintenance-confirmed") ||
      !flags.has("--services-stopped-confirmed") ||
      expectedUserCount === undefined ||
      expectedSnapshotFingerprint === undefined ||
      backupReceiptSha256 === undefined ||
      environment.CITYGO_ACCOUNT_BOOTSTRAP_CLOSED !== "true")
  )
    refuse(
      "Fresh-start требует явного удаления тестовой истории, закрытого maintenance, остановленных сервисов, точного числа аккаунтов, снимка и backup",
    );
  const db = await connectDatabase(connectionString);
  try {
    const identity = (
      await db.query<{
        database: string;
        role: string;
        session: string;
        elevated: boolean;
        owner: string;
        search_path: string;
      }>(
        "select current_database() as database,current_user as role,session_user as session,(r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls) as elevated,pg_get_userbyid(c.relowner) as owner,current_setting('search_path') as search_path from pg_catalog.pg_roles r join pg_catalog.pg_class c on c.oid='public.account_security_state'::regclass where r.rolname=current_user",
      )
    ).rows[0];
    const database = new URL(target).pathname.slice(1);
    if (
      !identity ||
      identity.database !== database ||
      identity.role !== "citygo_migrator" ||
      identity.session !== "citygo_migrator" ||
      identity.owner !== "citygo_migrator" ||
      identity.search_path !== controlledSearchPath ||
      identity.elevated
    )
      refuse(
        "Требуется точная БД и её ограниченный владелец citygo_migrator, не runtime API и не superuser",
      );
    const targetFingerprint = createHash("sha256")
      .update(`${actualEnvironment}|${target}`)
      .digest("hex");
    if (fresh) {
      const operation = new FreshAccountReset(db);
      if (!flags.has("--apply"))
        return {
          ...(await operation.plan({
            expectedUserCount,
            maintenanceConfirmed: flags.has("--maintenance-confirmed"),
          })),
          targetFingerprint,
        };
      const receipt = await operation.apply({
        expectedUserCount: expectedUserCount!,
        expectedSnapshotFingerprint: expectedSnapshotFingerprint!,
        backupReceiptSha256: backupReceiptSha256!,
        maintenanceConfirmed: true,
        servicesStoppedConfirmed: true,
        destructiveResetConfirmed: true,
        passwordHash: await hashPassword("admin"),
      });
      return {
        operation: receipt.operation,
        dryRun: false,
        accountsDeleted: receipt.accountsDeleted,
        username: receipt.admin.username,
        role: receipt.admin.role,
        mustChangePassword: true,
        accountingPreserved: false,
        knowledgeEmpty: true,
        operatorBudgetEnabled: false,
        externalObjectsDeleted: false,
        publicIngressMayOpen: false,
        targetFingerprint,
      };
    }
    if (restart) {
      const operation = new ClosedAccountRestart(db);
      if (!flags.has("--apply"))
        return {
          ...(await operation.plan({
            expectedUserCount,
            maintenanceConfirmed: flags.has("--maintenance-confirmed"),
          })),
          targetFingerprint,
        };
      // The expensive hash is prepared outside every DB transaction. The apply
      // method must recheck the pinned snapshot and all guards atomically.
      const receipt = await operation.apply({
        expectedUserCount: expectedUserCount!,
        expectedSnapshotFingerprint: expectedSnapshotFingerprint!,
        backupReceiptSha256: backupReceiptSha256!,
        maintenanceConfirmed: true,
        servicesStoppedConfirmed: true,
        retainedAuditsReviewed: true,
        passwordHash: await hashPassword("admin"),
      });
      // Whitelist the public operator receipt: no account IDs, credentials,
      // message data, connection descriptions or internal audit payloads.
      return {
        operation: "closed-account-restart",
        dryRun: false,
        accountsRetired: receipt.accountsRetired,
        accountsDeleted: 0,
        username: receipt.admin.username,
        role: receipt.admin.role,
        mustChangePassword: receipt.admin.mustChangePassword,
        accountingPreserved: receipt.accountingPreserved,
        publicIngressMayOpen: false,
        targetFingerprint,
      };
    }
    const plan = await new AccountReset(db).plan({
      expectedUserCount,
      maintenanceConfirmed: flags.has("--maintenance-confirmed"),
    });
    if (!bootstrap) return { ...plan, targetFingerprint };
    if (
      expectedUserCount !== 0 ||
      plan.accountCount !== 0 ||
      plan.bootstrapCompleted
    )
      refuse(
        "Первичный администратор допустим только в пустой базе до завершения bootstrap",
      );
    if (!flags.has("--apply"))
      return {
        operation: "bootstrap-admin",
        dryRun: true,
        accountsCreated: 0,
        accountCount: plan.accountCount,
        bootstrapCompleted: plan.bootstrapCompleted,
        targetFingerprint,
        maintenanceRequired: true,
      };
    // The known initial password is an explicit operator-only exception, never a
    // registration rule. Force-password-change guards forbid privileged use.
    const passwordHash = await hashPassword("admin");
    const admin = await new AccountAccess(db).bootstrapAdmin(passwordHash);
    return {
      operation: "bootstrap-admin",
      dryRun: false,
      accountsCreated: 1,
      oldAccountsDeleted: 0,
      username: admin.username,
      role: admin.role,
      mustChangePassword: admin.mustChangePassword,
      targetFingerprint,
      publicIngressMayOpen: false,
    };
  } finally {
    await db.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    console.log(
      JSON.stringify(
        await accountMaintenance(process.argv.slice(2), process.env),
        null,
        2,
      ),
    );
  } catch (error) {
    // Never print a driver error, connection URL, SQL, account data or secrets.
    console.error(
      JSON.stringify({
        error:
          error instanceof DomainError
            ? error.message
            : "Операция не выполнена; проверьте защищённый операторский контур",
        status: error instanceof DomainError ? error.statusCode : 500,
        accountsDeleted: 0,
      }),
    );
    process.exitCode = 1;
  }
}

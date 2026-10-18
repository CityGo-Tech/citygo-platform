// Operator-only source CLI. Never import this module from server.ts/dev.ts or
// expose it as HTTP. It deliberately loads no .env files and has no reset apply.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  AccountAccess,
  AccountReset,
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
      reset:
        "--apply-reset is deliberately unavailable; accounting anonymization and erasure require a separately reviewed operator workflow",
    };
  if (args.includes("--apply-reset"))
    refuse(
      "Сброс не реализован: сначала требуется проверяемая анонимизация учёта расходов, аудит и отдельный план удаления",
    );
  const allowedFlags = new Set([
    "--bootstrap-admin",
    "--apply",
    "--maintenance-confirmed",
  ]);
  const allowedValues = new Set([
    "--expected-target",
    "--expected-environment",
    "--expect-users",
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
  if (flags.has("--apply") && !bootstrap)
    refuse(
      "Изменения доступны только для явно выбранного первичного bootstrap; сброс недоступен",
    );
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
    const plan = await new AccountReset(db).plan({
      expectedUserCount,
      maintenanceConfirmed: flags.has("--maintenance-confirmed"),
    });
    const targetFingerprint = createHash("sha256")
      .update(`${actualEnvironment}|${target}`)
      .digest("hex");
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

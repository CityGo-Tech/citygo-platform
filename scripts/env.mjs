import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const root = fileURLToPath(new URL("../", import.meta.url));

// Deliberately no wildcards: NODE_OPTIONS, cloud credentials, proxy credentials,
// arbitrary NEXT_PUBLIC_/EXPO_PUBLIC_ values and npm config must not slip through.
const systemKeys = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "SystemDrive",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "CI",
  "TZ",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "npm_execpath",
  "npm_node_execpath",
  "CITYGO_CHILD_PROCESS",
];
export const apiKeys = [
  "NODE_ENV",
  "DATABASE_URL",
  "API_HOST",
  "API_PORT",
  "WEB_ORIGIN",
  "TRUSTED_PROXY_CIDRS",
  "ADMIN_USER_IDS",
  "EMAIL_REGISTRATION_MODE",
  "EMAIL_REGISTRATION_SECRET",
  "EMAIL_DELIVERY_PROVIDER",
  "POSTBOX_ACCESS_KEY_ID",
  "POSTBOX_SECRET_ACCESS_KEY",
  "POSTBOX_FROM_EMAIL",
  "EMAIL_SEND_DAILY_LIMIT",
  "EMAIL_SEND_TOTAL_LIMIT",
  "PHONE_VERIFICATION_MODE",
  "PHONE_VERIFICATION_SECRET",
  "SMS_RU_MODE",
  "SMS_RU_API_ID",
  "SMS_RU_FROM",
  "PROSTOSMS_MODE",
  "PROSTOSMS_API_KEY",
  "PROSTOSMS_SENDER",
  "PHONE_SMS_GLOBAL_DAILY_LIMIT",
  "PHONE_SMS_GLOBAL_TOTAL_LIMIT",
  "AI_CREDIT_MODE",
  "AI_CREDIT_RESERVATION_MODE",
  "AI_REQUEST_COST_LIMIT_MODE",
  "AI_CUSTOMER_BILLING_MODE",
  "AI_CONTEXT_STRATEGY",
  "AI_ASSISTANT_MODES",
  "AI_MINIMUM_FIXED_FEE",
  "AI_MAXIMUM_REASONING_EFFORT",
  "AI_MODES_DATA_NOTICE",
  "AI_MODES_PRODUCTION_POLICY_ID",
  "YOOKASSA_MODE",
  "YOOKASSA_SHOP_ID",
  "YOOKASSA_SECRET_KEY",
  "YOOKASSA_RECEIPT_MODE",
  "YOOKASSA_FISCAL_PROFILE",
  "R1_HOUSING_API_MODE",
  "LLM_PROVIDER",
  "LLM_REQUEST_TIMEOUT_MS",
  "LLM_MAX_OUTPUT_TOKENS",
  "LLM_MAX_INPUT_BYTES",
  "LLM_USER_DAILY_REQUEST_LIMIT",
  "LLM_GLOBAL_DAILY_REQUEST_LIMIT",
  "LLM_USER_DAILY_ATTEMPT_LIMIT",
  "LLM_GLOBAL_DAILY_ATTEMPT_LIMIT",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "ROUTERAI_API_KEY",
  "ROUTERAI_MODEL",
  "ROUTERAI_UPSTREAM",
  "ROUTERAI_COUNTRY",
  "ROUTERAI_DATA_NOTICE",
  "ROUTERAI_PRODUCTION_POLICY_ID",
  "ROUTERAI_REASONING_EFFORT",
  "ROUTERAI_MAX_OUTPUT_TOKENS",
  "ROUTERAI_REQUEST_TIMEOUT_MS",
  "GIGACHAT_CREDENTIALS",
  "GIGACHAT_MODEL",
  "GIGACHAT_SCOPE",
  "GIGACHAT_CA_BUNDLE_FILE",
];
// Public, non-secret analytics settings only. An arbitrary NEXT_PUBLIC_* is
// still rejected; enabling collection is a separate reviewed release choice.
const analyticsKeys = [
  "NEXT_PUBLIC_CITYGO_METRIKA_ENABLED",
  "NEXT_PUBLIC_CITYGO_METRIKA_COUNTER_ID",
  "NEXT_PUBLIC_CITYGO_METRIKA_WEBVISOR",
];
const webKeys = [
  "NODE_ENV",
  "API_INTERNAL_URL",
  "PORT",
  "NEXT_TELEMETRY_DISABLED",
  "CITYGO_WEB_STANDALONE",
  ...analyticsKeys,
];
const mobileKeys = [
  "NODE_ENV",
  "EXPO_PUBLIC_API_URL",
  "EXPO_PUBLIC_WEB_URL",
  "EXPO_OFFLINE",
  "REACT_NATIVE_PACKAGER_HOSTNAME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "JAVA_HOME",
];
const scopes = {
  api: apiKeys,
  web: webKeys,
  mobile: mobileKeys,
  worker: ["NODE_ENV", "DATABASE_URL"],
  migrator: ["NODE_ENV", "DATABASE_URL"],
  build: ["API_INTERNAL_URL", "CITYGO_WEB_STANDALONE", ...analyticsKeys],
  test: ["TEST_DATABASE_URL", "PLAYWRIGHT_BROWSERS_PATH"],
  "web-test": [],
};
const fileScopes = new Set(["api", "web", "mobile", "worker", "migrator"]);

function pick(source, keys, windows = process.platform === "win32") {
  const entries = new Map(
    Object.entries(source).map(([key, value]) => [
      windows ? key.toUpperCase() : key,
      value,
    ]),
  );
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = entries.get(windows ? key.toUpperCase() : key);
      return typeof value === "string" ? [[key, value]] : [];
    }),
  );
}
function readFile(directory, name) {
  const path = resolve(directory, name);
  if (!existsSync(path)) return {};
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    // Never include file contents (possibly credentials) in errors.
    throw new Error(`Cannot read environment file ${name}`);
  }
}

// Next auto-loads these files after launch, which would bypass the allowlist.
// Do not delete or rewrite them; fail with a migration instruction instead.
export function assertNoWebEnvFiles(directory = root) {
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
  ]) {
    if (existsSync(resolve(directory, "apps/web", name)))
      throw new Error(
        `Move apps/web/${name} settings to root .env.web; framework auto-loading bypasses service isolation`,
      );
  }
}

export function serviceEnv(
  scope,
  {
    inherited = process.env,
    directory = root,
    overrides = {},
    loadFiles = true,
  } = {},
) {
  if (!Object.hasOwn(scopes, scope))
    throw new Error("Unknown environment scope");
  const allowed = scopes[scope];
  let settings = {};
  if (loadFiles && ["api", "worker", "migrator"].includes(scope)) {
    settings = pick(readFile(directory, ".env"), allowed);
    // A split API file remains the DB fallback for local compatibility. A
    // dedicated worker/migrator file or injected DATABASE_URL takes precedence.
    if (scope !== "api")
      Object.assign(
        settings,
        pick(readFile(directory, ".env.api"), ["DATABASE_URL"]),
      );
  }
  // Build sees only Web's explicit non-secret inputs, before Turbo hashes them.
  const fileScope = scope === "build" ? "web" : scope;
  if (loadFiles && fileScopes.has(fileScope)) {
    const values = readFile(directory, `.env.${fileScope}`);
    if (Object.keys(values).some((key) => !scopes[fileScope].includes(key)))
      throw new Error(
        `Unsupported setting in .env.${fileScope}; use the service allowlist (values hidden)`,
      );
    Object.assign(settings, pick(values, allowed));
  }
  const env = {
    ...pick(inherited, systemKeys),
    ...settings,
    ...pick(inherited, allowed),
    ...pick(overrides, allowed),
  };
  if (["build", "web"].includes(scope)) {
    for (const key of [analyticsKeys[0], analyticsKeys[2]])
      if (env[key] !== undefined && !["disabled", "enabled"].includes(env[key]))
        throw new Error("Invalid public analytics switch (value hidden)");
    const counter = env.NEXT_PUBLIC_CITYGO_METRIKA_COUNTER_ID;
    if (
      counter !== undefined &&
      counter !== "" &&
      !/^[1-9][0-9]{0,9}$/.test(counter)
    )
      throw new Error("Invalid public analytics counter (value hidden)");
    if (env.NEXT_PUBLIC_CITYGO_METRIKA_ENABLED === "enabled" && !counter)
      throw new Error("Enabled analytics requires a public counter ID");
    if (
      env.NEXT_PUBLIC_CITYGO_METRIKA_WEBVISOR === "enabled" &&
      env.NEXT_PUBLIC_CITYGO_METRIKA_ENABLED !== "enabled"
    )
      throw new Error("Session replay requires enabled analytics");
  }
  if (
    scope === "web" &&
    env.NODE_ENV &&
    !["development", "test", "production"].includes(env.NODE_ENV)
  )
    throw new Error("Unsupported Web NODE_ENV (value hidden)");
  if (["api", "migrator"].includes(scope))
    env.DATABASE_URL ??= "pglite://" + resolve(directory, ".local/database");
  if (
    env.DATABASE_URL?.startsWith("pglite://") &&
    env.DATABASE_URL !== "pglite://:memory:"
  )
    env.DATABASE_URL =
      "pglite://" + resolve(directory, env.DATABASE_URL.slice(9));
  if (["build", "web", "web-test"].includes(scope))
    assertNoWebEnvFiles(directory);
  if (scope === "test") env.NODE_ENV = "test";
  if (scope === "web-test") {
    env.NODE_ENV = "production";
    env.API_INTERNAL_URL = "http://127.0.0.1:4000";
  }
  if (scope === "mobile") env.EXPO_NO_DOTENV = "1";
  return env;
}

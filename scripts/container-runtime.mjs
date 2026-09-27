import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { serviceEnv, root } from "./env.mjs";
import { launch } from "./process.mjs";

const modes = {
  api: { scope: "api", args: ["dist/server.js"] },
  web: { scope: "web", args: ["apps/web/server.js"] },
  migrate: { scope: "migrator", args: ["node_modules/@citygo/db/dist/cli.js"] },
  "migrate-release": {
    scope: "migrator",
    args: ["node_modules/@citygo/db/dist/release-cli.js"],
  },
  worker: { scope: "worker", args: ["dist/index.js", "--once"] },
};

const secretKeys = {
  api: [
    "DATABASE_URL",
    "ADMIN_USER_IDS",
    "OPENAI_API_KEY",
    "ROUTERAI_API_KEY",
    "GIGACHAT_CREDENTIALS",
  ],
  migrate: ["DATABASE_URL"],
  "migrate-release": ["DATABASE_URL"],
  worker: ["DATABASE_URL"],
};

// A separate, explicitly selected mounted profile. No ambient key, endpoint,
// fallback, customer bonus or operator monetary allowance can activate it.
const routerAiFixed = {
  AI_CREDIT_MODE: "routerai_at_cost",
  ROUTERAI_MODEL: "deepseek/deepseek-v4-pro-0813",
  ROUTERAI_UPSTREAM: "deepseek",
  ROUTERAI_COUNTRY: "us",
  ROUTERAI_REASONING_EFFORT: "high",
  ROUTERAI_MAX_OUTPUT_TOKENS: "32768",
  ROUTERAI_REQUEST_TIMEOUT_MS: "240000",
  LLM_MAX_INPUT_BYTES: "64000",
};
const routerAiLimits = {
  LLM_USER_DAILY_REQUEST_LIMIT: 10000,
  LLM_GLOBAL_DAILY_REQUEST_LIMIT: 1000000,
  LLM_USER_DAILY_ATTEMPT_LIMIT: 10000,
  LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: 1000000,
};
const routerAiKeys = [
  "DATABASE_URL",
  "ADMIN_USER_IDS",
  "ROUTERAI_API_KEY",
  "ROUTERAI_DATA_NOTICE",
  "ROUTERAI_PRODUCTION_POLICY_ID",
  ...Object.keys(routerAiFixed),
  ...Object.keys(routerAiLimits),
];

function validateRouterAi(value) {
  if (
    Object.keys(value).length !== routerAiKeys.length ||
    routerAiKeys.some(
      (key) =>
        typeof value[key] !== "string" ||
        !value[key] ||
        value[key] !== value[key].trim() ||
        [...value[key]].some((char) => char.charCodeAt(0) < 32),
    ) ||
    Object.entries(routerAiFixed).some(
      ([key, setting]) => value[key] !== setting,
    ) ||
    Object.entries(routerAiLimits).some(
      ([key, maximum]) =>
        !/^(0|[1-9][0-9]{0,6})$/.test(value[key]) ||
        Number(value[key]) > maximum,
    ) ||
    !/^[1-9][0-9]{0,17}(,[1-9][0-9]{0,17}){0,19}$/.test(value.ADMIN_USER_IDS) ||
    new Set(value.ADMIN_USER_IDS.split(",")).size !==
      value.ADMIN_USER_IDS.split(",").length ||
    !/^[a-f0-9]{64}$/.test(value.ROUTERAI_PRODUCTION_POLICY_ID) ||
    value.ROUTERAI_DATA_NOTICE.length > 4000 ||
    value.ROUTERAI_API_KEY.length > 8192
  )
    throw new Error();
}

export function containerSpec(
  mode,
  inherited = process.env,
  directory = root,
  secretDirectory = "/run/secrets",
) {
  if (!Object.hasOwn(modes, mode)) throw new Error("Unknown container mode");
  const { scope, args } = modes[mode];
  let secrets = {};
  const profile = inherited.CITYGO_AI_PROFILE;
  if (
    profile !== undefined &&
    (profile !== "routerai-credit-v1" ||
      mode !== "api" ||
      inherited.CITYGO_MOUNTED_CONFIG !== "1" ||
      inherited.LLM_PROVIDER !== "routerai" ||
      Object.keys(inherited).some(
        (key) =>
          key !== "LLM_PROVIDER" &&
          /^(OPENAI_|GIGACHAT_|ROUTERAI_|LLM_|AI_CREDIT_MODE$)/.test(key),
      ))
  )
    throw new Error("Invalid container AI profile (contents hidden)");
  if (inherited.CITYGO_MOUNTED_CONFIG !== undefined) {
    try {
      if (
        inherited.CITYGO_MOUNTED_CONFIG !== "1" ||
        !Object.hasOwn(secretKeys, mode)
      )
        throw new Error();
      const file = resolve(
        secretDirectory,
        `${mode === "migrate-release" ? "migrate" : mode}.json`,
      );
      if (
        !statSync(file).isFile() ||
        statSync(file).size > (profile ? 16384 : 65536)
      )
        throw new Error();
      secrets = JSON.parse(readFileSync(file, "utf8"));
      if (
        !secrets ||
        Array.isArray(secrets) ||
        typeof secrets !== "object" ||
        typeof secrets.DATABASE_URL !== "string" ||
        Object.entries(secrets).some(
          ([key, value]) =>
            !(profile ? routerAiKeys : secretKeys[mode]).includes(key) ||
            typeof value !== "string" ||
            !value.trim() ||
            /[\r\n\0]/.test(value),
        )
      )
        throw new Error();
      if (profile) validateRouterAi(secrets);
      // Avoid an accidental second source silently selecting the wrong database/key.
      if (Object.keys(secrets).some((key) => inherited[key] !== undefined))
        throw new Error();
    } catch {
      throw new Error(
        "Invalid mounted service configuration (contents hidden)",
      );
    }
  }
  // Containers must not load a forgotten developer .env or reuse API DB fallback.
  const env = serviceEnv(scope, {
    inherited: { ...inherited, ...secrets },
    directory,
    loadFiles: false,
    overrides: { NODE_ENV: "production" },
  });
  if (mode === "web") {
    env.HOSTNAME = "0.0.0.0";
    env.PORT ??= "3000";
  } else if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL ?? "")) {
    throw new Error("Container runtime requires an injected PostgreSQL URL");
  }
  return { env, args };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3) throw new Error("Supply one container mode");
    const { env, args } = containerSpec(mode);
    await launch("node", args, { env, cwd: root }).done;
  } catch {
    // Never reflect injected credentials or untrusted arguments into startup logs.
    console.error(
      "Container startup failed; check mode and scoped server configuration",
    );
    process.exitCode = 1;
  }
}

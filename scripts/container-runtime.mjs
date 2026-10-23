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
// Never reinterpret the legacy at-cost profile as a different customer tariff.
// Payments stay disabled: sandbox funds must not enter a real-AI database.
const citygo10xFixed = {
  ...routerAiFixed,
  AI_CREDIT_MODE: "routerai_citygo_10x",
  YOOKASSA_MODE: "disabled",
};
// Separate opt-in marker: adding a live key to either legacy profile is invalid.
// This selects transports, not permission to open ingress or spend AI budget.
const citygo10xLiveFixed = {
  ...citygo10xFixed,
  YOOKASSA_MODE: "live",
  YOOKASSA_RECEIPT_MODE: "npd_manual",
};
// New recipient/limits require a different mounted marker and release approval.
// Keep all legacy profile values unchanged; this is not an activation switch.
const citygo10xLiveCnFixed = {
  ...citygo10xLiveFixed,
  ROUTERAI_COUNTRY: "cn",
  ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
  LLM_MAX_INPUT_BYTES: "8192",
};
// Do not reinterpret already-approved receipt-free profiles. The receipt
// transport is a new independently pinned release/configuration identity.
const citygo10xLiveCnFiscalFixed = {
  ...citygo10xLiveCnFixed,
  YOOKASSA_FISCAL_PROFILE: "citygo_service_full_payment_v1",
};
// An independently mounted billing-risk profile. Old profile markers cannot
// silently acquire partial prepayment or a negative customer balance.
const citygo10xLiveCnFiscalOverdraftFixed = {
  ...citygo10xLiveCnFiscalFixed,
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
};
// Separate preparation-only identity; legacy mounted profiles never acquire
// verification credentials or sending permission through a larger keyset.
const citygo10xLiveCnFiscalOverdraftEmailFixed = {
  ...citygo10xLiveCnFiscalOverdraftFixed,
  EMAIL_REGISTRATION_MODE: "required",
  EMAIL_DELIVERY_PROVIDER: "yandex_postbox",
  POSTBOX_FROM_EMAIL: "no-reply@xn--c1ajazlh.xn--p1ai",
  PHONE_VERIFICATION_MODE: "disabled",
  SMS_RU_MODE: "disabled",
};
const emailLimits = {
  EMAIL_SEND_DAILY_LIMIT: 100000,
  EMAIL_SEND_TOTAL_LIMIT: 1000000,
};
const routerAiProfiles = {
  "routerai-credit-v1": routerAiFixed,
  "routerai-citygo-10x-v1": citygo10xFixed,
  "routerai-citygo-10x-yookassa-live-v1": citygo10xLiveFixed,
  "routerai-citygo-10x-yookassa-live-cn-v1": citygo10xLiveCnFixed,
  "routerai-citygo-10x-yookassa-live-cn-fiscal-v2": citygo10xLiveCnFiscalFixed,
  "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-v1":
    citygo10xLiveCnFiscalOverdraftFixed,
  "routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-v1":
    citygo10xLiveCnFiscalOverdraftEmailFixed,
};
const routerAiKeys = (fixed) => [
  "DATABASE_URL",
  "ADMIN_USER_IDS",
  "ROUTERAI_API_KEY",
  "ROUTERAI_DATA_NOTICE",
  "ROUTERAI_PRODUCTION_POLICY_ID",
  ...Object.keys(fixed),
  ...Object.keys(routerAiLimits),
  ...(fixed.YOOKASSA_MODE === "live"
    ? ["YOOKASSA_SHOP_ID", "YOOKASSA_SECRET_KEY"]
    : []),
  ...(fixed.EMAIL_DELIVERY_PROVIDER === "yandex_postbox"
    ? [
        "EMAIL_REGISTRATION_SECRET",
        "POSTBOX_ACCESS_KEY_ID",
        "POSTBOX_SECRET_ACCESS_KEY",
        ...Object.keys(emailLimits),
      ]
    : []),
];

function validateRouterAi(value, fixed) {
  const keys = routerAiKeys(fixed);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some(
      (key) =>
        typeof value[key] !== "string" ||
        !value[key] ||
        value[key] !== value[key].trim() ||
        [...value[key]].some((char) => char.charCodeAt(0) < 32),
    ) ||
    Object.entries(fixed).some(([key, setting]) => value[key] !== setting) ||
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
    value.ROUTERAI_API_KEY.length > 8192 ||
    (fixed.YOOKASSA_MODE === "live" &&
      (!/^[1-9][0-9]{0,19}$/.test(value.YOOKASSA_SHOP_ID) ||
        !/^live_[A-Za-z0-9_=-]{8,8192}$/.test(value.YOOKASSA_SECRET_KEY))) ||
    (fixed.EMAIL_DELIVERY_PROVIDER === "yandex_postbox" &&
      (!/^[a-f0-9]{64}$/.test(value.EMAIL_REGISTRATION_SECRET) ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(value.POSTBOX_ACCESS_KEY_ID) ||
        !/^[!-~]{16,256}$/.test(value.POSTBOX_SECRET_ACCESS_KEY) ||
        // This exact email-only sentinel does not change AI/SMS quota policy.
        Object.entries(emailLimits).some(
          ([key, maximum]) =>
            value[key] !== "unlimited" &&
            (!/^[1-9][0-9]{0,6}$/.test(value[key]) ||
              Number(value[key]) > maximum),
        )))
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
    inherited.CITYGO_MOUNTED_CONFIG !== undefined &&
    Object.keys(inherited).some((key) =>
      /^(EMAIL_|POSTBOX_|PHONE_|SMS_)/.test(key),
    )
  )
    throw new Error(
      "Invalid mounted verification configuration (contents hidden)",
    );
  if (
    profile !== undefined &&
    (!Object.hasOwn(routerAiProfiles, profile) ||
      mode !== "api" ||
      inherited.CITYGO_MOUNTED_CONFIG !== "1" ||
      inherited.LLM_PROVIDER !== "routerai" ||
      Object.keys(inherited).some(
        (key) =>
          key !== "LLM_PROVIDER" &&
          /^(OPENAI_|GIGACHAT_|ROUTERAI_|LLM_|YOOKASSA_|AI_CREDIT_)/.test(key),
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
            !(
              profile
                ? routerAiKeys(routerAiProfiles[profile])
                : secretKeys[mode]
            ).includes(key) ||
            typeof value !== "string" ||
            !value.trim() ||
            /[\r\n\0]/.test(value),
        )
      )
        throw new Error();
      if (profile) validateRouterAi(secrets, routerAiProfiles[profile]);
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

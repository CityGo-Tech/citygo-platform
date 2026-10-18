import { z } from "zod";
import { isIP } from "node:net";
import { aiProviderIdSchema, type AiProviderId } from "@citygo/contracts";

const optionalSetting = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z.string().optional(),
);
const optionalIntegerSetting = (min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.coerce.number().int().min(min).max(max).optional(),
  );

const trustedProxySchema = z
  .string()
  .default("")
  .transform((value, ctx) => {
    if (!value.trim()) return [];
    const addresses = value.split(",").map((address) => address.trim());
    for (const address of addresses) {
      const [ip, prefix, ...extra] = address.split("/");
      const version = isIP(ip ?? "");
      const bits = version === 4 ? 32 : 128;
      if (
        !version ||
        extra.length ||
        (prefix !== undefined &&
          (!/^\d+$/.test(prefix) ||
            Number(prefix) < 1 ||
            Number(prefix) > bits))
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "TRUSTED_PROXY_CIDRS must contain explicit IPs/CIDRs, never wildcard, boolean or hop-count trust",
        });
        return z.NEVER;
      }
    }
    return addresses;
  });
export const serverConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("pglite://.local/database"),
  LLM_PROVIDER: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    aiProviderIdSchema.or(z.literal("disabled")).optional(),
  ),
  LLM_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(60000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8000).default(1400),
  // Serialized instructions + messages, UTF-8 bytes (not a token estimate).
  LLM_MAX_INPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(262144)
    .default(64000),
  // Accepted chat requests, not currency or upstream HTTP-attempt accounting.
  LLM_USER_DAILY_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(20),
  LLM_GLOBAL_DAILY_REQUEST_LIMIT: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000000)
    .default(200),
  OPENAI_API_KEY: optionalSetting,
  // Reserved model attempts, including retries; independent of chat admissions.
  LLM_USER_DAILY_ATTEMPT_LIMIT: z.coerce
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(20),
  LLM_GLOBAL_DAILY_ATTEMPT_LIMIT: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000000)
    .default(200),
  OPENAI_MODEL: optionalSetting,
  ROUTERAI_API_KEY: optionalSetting,
  ROUTERAI_MODEL: optionalSetting,
  ROUTERAI_UPSTREAM: optionalSetting,
  ROUTERAI_COUNTRY: optionalSetting,
  // Public operator notice, displayed to users and bound into their consent ID.
  // Not a credential and not proof of legal approval by itself.
  ROUTERAI_DATA_NOTICE: optionalSetting.pipe(z.string().max(4000).optional()),
  ROUTERAI_PRODUCTION_POLICY_ID: optionalSetting.pipe(
    z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  ),
  ROUTERAI_REASONING_EFFORT: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() || undefined : value),
    z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  ),
  ROUTERAI_MAX_OUTPUT_TOKENS: optionalIntegerSetting(1, 32768),
  ROUTERAI_REQUEST_TIMEOUT_MS: optionalIntegerSetting(1000, 240000),
  GIGACHAT_CREDENTIALS: optionalSetting,
  GIGACHAT_MODEL: optionalSetting,
  GIGACHAT_SCOPE: optionalSetting,
  GIGACHAT_CA_BUNDLE_FILE: optionalSetting,
  ADMIN_USER_IDS: z.string().default(""),
  AI_CREDIT_MODE: z
    .enum(["disabled", "routerai_at_cost", "routerai_citygo_10x"])
    .default("disabled"),
  YOOKASSA_MODE: z.enum(["disabled", "test", "live"]).default("disabled"),
  YOOKASSA_SHOP_ID: optionalSetting,
  YOOKASSA_SECRET_KEY: optionalSetting,
  // Technical workflow selection, not a tax opinion or provider contract.
  // Live acceptance remains an independent release/merchant decision.
  YOOKASSA_RECEIPT_MODE: z.enum(["disabled", "npd_manual"]).default("disabled"),
  // Development rehearsal only. This flag is not a production approval.
  R1_HOUSING_API_MODE: z.enum(["disabled", "synthetic"]).default("disabled"),
  TRUSTED_PROXY_CIDRS: trustedProxySchema,
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = serverConfigSchema.parse(env);
  validatePaymentConfig(config);
  if (
    config.NODE_ENV === "production" &&
    config.R1_HOUSING_API_MODE !== "disabled"
  )
    throw new Error(
      "R1 housing API is synthetic-only; production activation is not implemented",
    );
  if (
    config.NODE_ENV === "production" &&
    (!/^postgres(?:ql)?:\/\//.test(config.DATABASE_URL) ||
      new URL(config.WEB_ORIGIN).protocol !== "https:")
  ) {
    throw new Error("Production requires PostgreSQL and HTTPS WEB_ORIGIN");
  }
  if (config.NODE_ENV === "production" && !config.TRUSTED_PROXY_CIDRS.length)
    throw new Error(
      "Production requires explicit TRUSTED_PROXY_CIDRS for the Web proxy; see docs/runbooks/production.md",
    );
  return config;
}

// Reused before DB access for explicitly injected config too. Neither a live
// key nor an untrusted provider response can select a payment mode implicitly.
export function validatePaymentConfig(
  config: z.infer<typeof serverConfigSchema>,
) {
  if (!["disabled", "test", "live"].includes(config.YOOKASSA_MODE))
    throw new Error("Unsupported YooKassa mode");
  if (config.YOOKASSA_MODE === "disabled") return;
  if (
    config.YOOKASSA_MODE === "test" &&
    (config.NODE_ENV === "production" ||
      config.LLM_PROVIDER !== "disabled" ||
      config.AI_CREDIT_MODE !== "routerai_citygo_10x" ||
      !/^[1-9][0-9]{0,19}$/.test(config.YOOKASSA_SHOP_ID ?? "") ||
      !/^test_[A-Za-z0-9_=-]{8,8192}$/.test(config.YOOKASSA_SECRET_KEY ?? ""))
  )
    throw new Error(
      "YooKassa test checkout requires an isolated non-production environment, disabled AI, CityGo 10x and test credentials",
    );
  if (
    config.YOOKASSA_MODE === "live" &&
    (config.AI_CREDIT_MODE !== "routerai_citygo_10x" ||
      !["disabled", "routerai"].includes(config.LLM_PROVIDER ?? "") ||
      config.YOOKASSA_RECEIPT_MODE !== "npd_manual" ||
      !/^[1-9][0-9]{0,19}$/.test(config.YOOKASSA_SHOP_ID ?? "") ||
      !/^live_[A-Za-z0-9_=-]{8,8192}$/.test(config.YOOKASSA_SECRET_KEY ?? ""))
  )
    throw new Error(
      "YooKassa live checkout requires explicit live credentials, CityGo 10x, RouterAI or disabled AI and the manual NPD receipt workflow",
    );
  const origin = new URL(config.WEB_ORIGIN);
  if (
    config.YOOKASSA_MODE === "live" &&
    (origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      (origin.port && origin.port !== "443") ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash)
  )
    throw new Error("YooKassa checkout requires a fixed HTTPS return origin");
}

export function effectiveLlmLimits(
  config: ReturnType<typeof readConfig>,
  provider: AiProviderId,
  model?: string,
) {
  const requestTimeoutMs =
    provider === "routerai"
      ? (config.ROUTERAI_REQUEST_TIMEOUT_MS ?? config.LLM_REQUEST_TIMEOUT_MS)
      : config.LLM_REQUEST_TIMEOUT_MS;
  return {
    maxOutputCharacters:
      provider === "routerai" &&
      (model === "openai/gpt-6-astra" ||
        model === "deepseek/deepseek-v4-pro-0813")
        ? 128000
        : 24000,
    maxOutputTokens:
      provider === "routerai"
        ? (config.ROUTERAI_MAX_OUTPUT_TOKENS ?? config.LLM_MAX_OUTPUT_TOKENS)
        : config.LLM_MAX_OUTPUT_TOKENS,
    requestTimeoutMs,
    // Keep the historical 90s floor; a slow provider needs its full deadline
    // plus time to persist the result before another request can take its lease.
    chatLeaseMs: Math.max(90000, requestTimeoutMs + 30000),
  };
}

import { z } from "zod";
import { isIP } from "node:net";
import { aiProviderIdSchema } from "@citygo/contracts";

const optionalSetting = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z.string().optional(),
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
  GIGACHAT_CREDENTIALS: optionalSetting,
  GIGACHAT_MODEL: optionalSetting,
  GIGACHAT_SCOPE: optionalSetting,
  GIGACHAT_CA_BUNDLE_FILE: optionalSetting,
  ADMIN_USER_IDS: z.string().default(""),
  TRUSTED_PROXY_CIDRS: trustedProxySchema,
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = serverConfigSchema.parse(env);
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

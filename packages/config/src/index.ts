import { z } from "zod";
import { isIP } from "node:net";

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
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
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

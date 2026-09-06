import { z } from "zod";
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
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = serverConfigSchema.parse(env);
  if (
    config.NODE_ENV === "production" &&
    (!config.DATABASE_URL.startsWith("postgres") ||
      !config.WEB_ORIGIN.startsWith("https://"))
  ) {
    throw new Error("Production requires PostgreSQL and HTTPS WEB_ORIGIN");
  }
  return config;
}

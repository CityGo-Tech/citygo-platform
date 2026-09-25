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

export function containerSpec(
  mode,
  inherited = process.env,
  directory = root,
  secretDirectory = "/run/secrets",
) {
  if (!Object.hasOwn(modes, mode)) throw new Error("Unknown container mode");
  const { scope, args } = modes[mode];
  let secrets = {};
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
      if (!statSync(file).isFile() || statSync(file).size > 65536)
        throw new Error();
      secrets = JSON.parse(readFileSync(file, "utf8"));
      if (
        !secrets ||
        Array.isArray(secrets) ||
        typeof secrets !== "object" ||
        typeof secrets.DATABASE_URL !== "string" ||
        Object.entries(secrets).some(
          ([key, value]) =>
            !secretKeys[mode].includes(key) ||
            typeof value !== "string" ||
            !value.trim() ||
            /[\r\n\0]/.test(value),
        )
      )
        throw new Error();
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

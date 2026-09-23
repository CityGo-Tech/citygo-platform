import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serviceEnv, root } from "./env.mjs";
import { launch } from "./process.mjs";

const modes = {
  api: { scope: "api", args: ["dist/server.js"] },
  web: { scope: "web", args: ["apps/web/server.js"] },
  migrate: { scope: "migrator", args: ["node_modules/@citygo/db/dist/cli.js"] },
  worker: { scope: "worker", args: ["dist/index.js", "--once"] },
};

export function containerSpec(mode, inherited = process.env, directory = root) {
  if (!Object.hasOwn(modes, mode)) throw new Error("Unknown container mode");
  const { scope, args } = modes[mode];
  // Containers must not load a forgotten developer .env or reuse API DB fallback.
  const env = serviceEnv(scope, {
    inherited,
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

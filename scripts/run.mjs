import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(resolve(root, ".env")))
  process.loadEnvFile(resolve(root, ".env"));
process.env.DATABASE_URL ??= "pglite://" + resolve(root, ".local/database");
process.env.API_INTERNAL_URL ??= "http://127.0.0.1:" + (process.env.API_PORT ?? "4000");
if (
  process.env.DATABASE_URL.startsWith("pglite://") &&
  !process.env.DATABASE_URL.startsWith("pglite://:memory:")
) {
  process.env.DATABASE_URL =
    "pglite://" + resolve(root, process.env.DATABASE_URL.slice(9));
}
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Command failed: " + args.join(" "))),
    );
    child.on("error", reject);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => child.kill(signal));
  });
const mode = process.argv[2];
if (mode === "dev" || mode === "migrate") {
  await run(["turbo", "run", "build", "--filter=./packages/*", "--concurrency=3"]);
  await run(["exec", "node", "packages/db/dist/cli.js"]);
}
if (mode === "dev")
  await run([
    "turbo",
    "run",
    "dev",
    "--concurrency=20",
    "--filter=@citygo/web...",
    "--filter=@citygo/api...",
  ]);
else if (mode === "start")
  await run([
    "turbo",
    "run",
    "start",
    "--filter=@citygo/web",
    "--filter=@citygo/api",
  ]);
else if (mode !== "migrate") throw new Error("Unknown mode");

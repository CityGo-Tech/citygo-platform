import { root, serviceEnv } from "./env.mjs";
import { launch } from "./process.mjs";

const mode = process.argv[2];
if (!["dev", "start", "migrate"].includes(mode))
  throw new Error("Unknown mode");
const run = (scope, command, args, overrides = {}) =>
  launch(command, args, {
    cwd: root,
    env: serviceEnv(scope, { overrides }),
  });
if (mode === "dev" || mode === "migrate") {
  await run("build", "pnpm", [
    "turbo",
    "run",
    "build",
    "--filter=./packages/*",
    "--concurrency=3",
  ]).done;
  await run("migrator", "node", ["packages/db/dist/cli.js"]).done;
}
if (mode !== "migrate") {
  const NODE_ENV = mode === "start" ? "production" : "development";
  const api = serviceEnv("api", { overrides: { NODE_ENV } });
  const web = serviceEnv("web", { overrides: { NODE_ENV } });
  web.API_INTERNAL_URL ??= "http://127.0.0.1:" + (api.API_PORT ?? "4000");
  // Never send the union of runtime secrets through Turbo or Web. Dependencies
  // were built above (dev) or explicitly by pnpm build (production).
  const children = [
    launch("pnpm", ["--filter", "@citygo/api", mode], { cwd: root, env: api }),
    launch("pnpm", ["--filter", "@citygo/web", mode], { cwd: root, env: web }),
  ];
  try {
    await Promise.race(children.map(({ done }) => done));
  } finally {
    for (const { stop } of children) stop();
    await Promise.allSettled(children.map(({ done }) => done));
  }
}

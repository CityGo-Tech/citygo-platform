import { root, serviceEnv } from "./env.mjs";
import { launch } from "./process.mjs";
await launch("node", ["apps/worker/dist/index.js", "--once"], {
  cwd: root,
  env: serviceEnv("worker"),
}).done;

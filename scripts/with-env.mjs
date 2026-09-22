import { serviceEnv } from "./env.mjs";
import { launch } from "./process.mjs";

const [scope, command, ...args] = process.argv.slice(2);
try {
  await launch(command, args, { env: serviceEnv(scope), cwd: process.cwd() })
    .done;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

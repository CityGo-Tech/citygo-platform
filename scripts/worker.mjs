import { existsSync } from "node:fs";
if (existsSync(".env")) process.loadEnvFile(".env");
process.argv.push("--once");
await import("../apps/worker/dist/index.js");

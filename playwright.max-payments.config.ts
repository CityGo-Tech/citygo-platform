import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

if (!Array.isArray(base.webServer) || base.webServer.length !== 2)
  throw new Error("Expected the API and Web Playwright services");

export default defineConfig({
  ...base,
  testDir: "./e2e-max-payments",
  webServer: [
    {
      ...base.webServer[0]!,
      command:
        "node scripts/with-env.mjs test pnpm --filter @citygo/api exec tsx src/test-max-payment-server.ts",
    },
    base.webServer[1]!,
  ],
});

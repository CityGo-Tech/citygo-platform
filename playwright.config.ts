import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: [
    {
      command: "pnpm --filter @citygo/api exec tsx src/test-server.ts",
      url: "http://127.0.0.1:4000/ready",
      env: { NODE_ENV: "test" },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: "pnpm --filter @citygo/web start",
      url: "http://localhost:3000",
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-web",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});

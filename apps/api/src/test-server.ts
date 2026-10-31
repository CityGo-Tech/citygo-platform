// Only the E2E harness starts this entry point. It is not included in the API build.
import { connectDatabase, migrate } from "@citygo/db";
import { TestProvider } from "@citygo/testkit";
import { buildApp } from "./app.js";
import { readConfig } from "@citygo/config";
import { seedTestBudget } from "./test-budget.js";
import { ApiDrain, installShutdown } from "./shutdown.js";
import { seedObservabilityE2eFixture } from "./test-customer-observability.js";
if (process.env.NODE_ENV !== "test")
  throw new Error("Test server requires NODE_ENV=test");
const testDatabaseUrl = "pglite://:memory:";
// Only this guarded in-memory entrypoint trusts the local Next.js test proxy.
// Browser fixtures can use independent synthetic clients without weakening the
// unchanged per-client limits shared by unrelated real-HTTP E2E scenarios.
const config = {
  ...readConfig(),
  TRUSTED_PROXY_CIDRS: ["127.0.0.1/32", "::1/128"],
};
const db = await connectDatabase(testDatabaseUrl);
await migrate(db);
await seedTestBudget(db, config, { openai: new TestProvider() });
const drain = new ApiDrain();
const app = await buildApp({
  db,
  provider: new TestProvider(),
  config,
  testing: true,
  drain,
});
app.addHook("onClose", () => db.close());
await seedObservabilityE2eFixture(db, app, testDatabaseUrl);
installShutdown(app, drain);
await app.listen({ host: "127.0.0.1", port: 4000 });

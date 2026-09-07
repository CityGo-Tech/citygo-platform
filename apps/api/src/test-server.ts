// Only the E2E harness starts this entry point. It is not included in the API build.
import { connectDatabase, migrate } from "@citygo/db";
import { TestProvider } from "@citygo/testkit";
import { buildApp } from "./app.js";
import { readConfig } from "@citygo/config";
import { seedTestBudget } from "./test-budget.js";
if (process.env.NODE_ENV !== "test")
  throw new Error("Test server requires NODE_ENV=test");
const db = await connectDatabase("pglite://:memory:");
await migrate(db);
await seedTestBudget(db, readConfig(), { openai: new TestProvider() });
const app = await buildApp({ db, provider: new TestProvider(), testing: true });
app.addHook("onClose", () => db.close());
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: "127.0.0.1", port: 4000 });

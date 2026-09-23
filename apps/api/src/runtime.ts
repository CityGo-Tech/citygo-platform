import { readConfig } from "@citygo/config";
import { connectDatabase } from "@citygo/db";
import { buildApp } from "./app.js";
import { createProviderRegistry } from "./provider.js";
import { ApiDrain, installShutdown } from "./shutdown.js";

export async function startServer() {
  const config = readConfig();
  const registry = createProviderRegistry(config);
  const db = await connectDatabase(config.DATABASE_URL);
  const drain = new ApiDrain();
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp({ db, config, ...registry, drain });
  } catch (error) {
    await db.close();
    throw error;
  }
  app.addHook("onClose", () => db.close());
  const removeSignals = installShutdown(app, drain);
  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
  } catch (error) {
    removeSignals();
    await app.close();
    throw error;
  }
}

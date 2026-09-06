import { readConfig } from "@citygo/config";
import { connectDatabase } from "@citygo/db";
import { buildApp } from "./app.js";
import { createProvider } from "./provider.js";

export async function startServer() {
  const config = readConfig();
  const provider = createProvider(config);
  const db = await connectDatabase(config.DATABASE_URL);
  const app = await buildApp({ db, config, provider });
  app.addHook("onClose", () => db.close());
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close();
    });
  try {
    await app.listen({ host: config.API_HOST, port: config.API_PORT });
  } catch (error) {
    await app.close();
    throw error;
  }
}

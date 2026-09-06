import { readConfig } from "@citygo/config";
import { connectDatabase } from "@citygo/db";
import { OpenAIProvider } from "@citygo/llm";
import { buildApp } from "./app.js";

export async function startServer() {
  const config = readConfig();
  const db = await connectDatabase(config.DATABASE_URL);
  const provider =
    config.OPENAI_API_KEY && config.OPENAI_MODEL
      ? new OpenAIProvider(config.OPENAI_API_KEY, config.OPENAI_MODEL)
      : undefined;
  const app = buildApp({ db, config, provider });
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

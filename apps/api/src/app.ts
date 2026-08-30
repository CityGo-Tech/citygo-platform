import cors from "@fastify/cors";
import Fastify from "fastify";

import { healthResponseSchema } from "@citygo/contracts";

export function buildApp() {
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: true });

  app.get("/health", async () =>
    healthResponseSchema.parse({
      service: "citygo-api",
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  );

  return app;
}

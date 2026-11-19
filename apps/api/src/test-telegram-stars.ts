// This fixture is imported only by the isolated browser test entrypoint.
import { randomUUID } from "node:crypto";
import type { Database } from "@citygo/db";
import type { FastifyInstance } from "fastify";
import { hashPassword, tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

export const telegramStarsTestFixture = {
  webhookSecret: "citygo-public-stars-webhook-fixture-v1",
  refundStarPayment: async () => true,
};

export async function seedTelegramStarsTestFixture(
  db: Database,
  app: FastifyInstance,
  databaseUrl: string,
) {
  if (process.env.NODE_ENV !== "test" || databaseUrl !== "pglite://:memory:")
    throw new Error(
      "Stars fixtures require an isolated in-memory test database",
    );

  const passwordHash = await hashPassword(randomUUID());
  const actors = ["desktop-0", "desktop-1", "mobile-web-0", "mobile-web-1"];
  for (const [index, name] of actors.entries()) {
    const userId = await registerSyntheticConsentingUser(
      db,
      `telegram-stars-${name}@example.test`,
      passwordHash,
      app,
    );
    await db.query(
      "insert into messenger_accounts(provider,subject,user_id) values('telegram',$1,$2)",
      [1_430_000 + index, userId],
    );
    for (const kind of ["telegram", "web"] as const) {
      const token = tokenHash(`citygo-telegram-stars-test-v1:${name}:${kind}`);
      await db.query(
        `insert into sessions(token_hash,user_id,expires_at,messenger_provider)
         values($1,$2,clock_timestamp()+interval '1 day',$3)`,
        [tokenHash(token), userId, kind === "telegram" ? kind : null],
      );
    }
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { connectDatabase, migrate } from "@citygo/db";
import { buildApp } from "./app.js";
import { TELEGRAM_STARS_TEST_WEBHOOK_PATH } from "./telegram-stars/http.js";

test("Telegram Stars test routes require test mode and an explicit fixture", async () => {
  const db = await connectDatabase("pglite://:memory:");
  const config = readConfig({ NODE_ENV: "test" });
  const telegramStarsTest = {
    webhookSecret: "synthetic-stars-access-test",
    refundStarPayment: async () => true,
  };

  try {
    await assert.rejects(
      buildApp({ db, config, telegramStarsTest }),
      /isolated test harness/,
    );
    await assert.rejects(
      buildApp({
        db,
        config: { ...config, NODE_ENV: "production" },
        testing: true,
        telegramStarsTest,
      }),
      /isolated test harness/,
    );

    await migrate(db);
    const app = await buildApp({ db, config, testing: true });
    try {
      assert.equal(
        app.hasRoute({ method: "GET", url: "/v1/mini-apps/telegram/stars" }),
        false,
      );
      assert.equal(
        app.hasRoute({ method: "POST", url: TELEGRAM_STARS_TEST_WEBHOOK_PATH }),
        false,
      );
    } finally {
      await app.close();
    }
  } finally {
    await db.close();
  }
});

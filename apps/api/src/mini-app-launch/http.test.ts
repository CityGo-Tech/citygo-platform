import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { readConfig } from "@citygo/config";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { connectDatabase, migrate } from "@citygo/db";
import { redactPaths } from "@citygo/observability";
import { buildApp } from "../app.js";
import { serializeRequestLog } from "../customer-observability.js";
import { registerMiniAppLaunch } from "./http.js";

const tokens = {
  telegram: "1111111111:QaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqR",
  max: "2222222222:QqPpOoNnMmLlKkJjIiHhGgFfEeDdCcBbAaZ",
};
type Provider = keyof typeof tokens;
const contact = "private-miniapp+canary@example.test";
const launchId = "7e50ac79-284d-4a94-9b24-e172291edfff";
const userId = 48231759842;
const route = (provider: Provider) => `/v1/mini-apps/${provider}/verify`;

function signedLaunch(provider: Provider, authDate: number) {
  const fields: Record<string, string> = {
    query_id: launchId,
    auth_date: String(authDate),
    user: JSON.stringify({
      id: userId,
      first_name: "Тестовый пользователь",
      photo_url: "https://example.test/" + contact,
    }),
    start_param: provider === "telegram" ? "housing" : "coordinator",
  };
  const ordered = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData")
    .update(tokens[provider])
    .digest();
  fields.hash = createHmac("sha256", secret).update(ordered).digest("hex");
  // Preserve the stable signed content while sending a different key order.
  return new URLSearchParams(Object.entries(fields).reverse()).toString();
}

function send(
  app: FastifyInstance,
  url: string,
  payload: string,
  contentType = "text/plain; charset=utf-8",
) {
  return app.inject({
    method: "POST",
    url,
    payload,
    headers: {
      "content-type": contentType,
      origin: "http://localhost:3000",
      [CONTRACT_VERSION_HEADER]: "1",
    },
  });
}

test("Telegram and MAX launch checks only return purpose and never create a session or mutate CityGo state", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  const lifecycle: { app?: FastifyInstance } = {};
  t.after(async () => {
    try {
      await lifecycle.app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "disabled",
      TELEGRAM_MINI_APP_BOT_TOKEN: tokens.telegram,
      MAX_MINI_APP_BOT_TOKEN: tokens.max,
    }),
  });
  lifecycle.app = app;

  const timestamp = Math.floor(Date.now() / 1000);
  const telegram = signedLaunch("telegram", timestamp);
  const max = signedLaunch("max", timestamp);
  for (const [provider, payload, purpose] of [
    ["telegram", telegram, "housing"],
    ["max", max, "coordinator"],
  ] as const) {
    // The second request is still verification only and does not consume or mint
    // a credential for a later account action.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(app, route(provider), payload);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { verified: true, purpose });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["set-cookie"], undefined);
    }
  }

  const errors = new Set<string>();
  for (const [url, payload] of [
    [route("telegram"), max],
    [route("max"), telegram],
    [route("telegram"), signedLaunch("telegram", timestamp - 7200)],
    [route("max"), signedLaunch("max", timestamp - 7200)],
    [route("telegram"), `${telegram}&auth_date=${timestamp}`],
    [route("max"), max.replace("coordinator", "housing")],
  ] as const) {
    const response = await send(app, url, payload);
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.ok(!response.body.includes(contact));
    errors.add(response.json<{ error: string }>().error);
  }
  assert.equal(errors.size, 1);

  const oversized = await send(app, route("telegram"), "x".repeat(8193));
  assert.equal(oversized.statusCode, 413);
  const json = await send(
    app,
    route("telegram"),
    JSON.stringify({ initData: telegram }),
    "application/json",
  );
  assert.equal(json.statusCode, 415);

  const dashboard = await app.inject({ method: "GET", url: "/v1/dashboard" });
  assert.equal(dashboard.statusCode, 401);
  assert.deepEqual(
    (
      await db.query(`
        select (select count(*)::text from users) as users,
               (select count(*)::text from sessions) as sessions,
               (select count(*)::text from analytics_events) as analytics
      `)
    ).rows,
    [{ users: "0", sessions: "0", analytics: "0" }],
  );
});

test("launch handlers and API-style request logging omit signed body, query, contacts and bot tokens", async (t) => {
  const records: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      records.push(String(chunk));
      done();
    },
  });
  const app = Fastify({
    logger: {
      redact: redactPaths,
      serializers: { req: serializeRequestLog },
      stream,
    },
  });
  t.after(() => app.close());
  assert.throws(
    () =>
      registerMiniAppLaunch(app, {
        telegramToken: tokens.telegram,
        maxToken: tokens.telegram,
      }),
    /distinct bot tokens/,
  );
  registerMiniAppLaunch(app, { telegramToken: tokens.telegram });

  const timestamp = Math.floor(Date.now() / 1000);
  const launch = signedLaunch("telegram", timestamp);
  const good = await send(app, route("telegram"), launch);
  assert.equal(good.statusCode, 200);
  const invalid = await send(app, route("telegram"), launch + "&user=bad");
  assert.equal(invalid.statusCode, 400);
  const rejectedQuery = await send(
    app,
    route("telegram") + "?initData=" + encodeURIComponent(contact),
    launch,
    new URLSearchParams(launch).get("hash")!,
  );
  assert.equal(rejectedQuery.statusCode, 400);
  const disabled = await send(
    app,
    route("max"),
    signedLaunch("max", timestamp),
  );
  assert.equal(disabled.statusCode, 404);

  const logged = records.join("");
  assert.ok(logged.includes(route("telegram")));
  const publicData = logged + good.body + invalid.body + rejectedQuery.body;
  for (const value of [
    launch,
    contact,
    encodeURIComponent(contact),
    launchId,
    String(userId),
    tokens.telegram,
    tokens.max,
  ])
    assert.ok(!publicData.includes(value));
});

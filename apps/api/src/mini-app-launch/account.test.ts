import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { connectDatabase, migrate } from "@citygo/db";
import { buildApp } from "../app.js";
import { syntheticConsentsFor } from "../test-service-consents.js";

const tokens = {
  telegram: "synthetic-telegram-account-token",
  max: "synthetic-max-account-token",
};
const password = "synthetic-password";
const sign = (provider: keyof typeof tokens, age = 0) => {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    query_id: randomUUID(),
    start_param: "housing",
    user: '{"id":123456789,"first_name":"Synthetic","email":"untrusted@example.test"}',
  };
  const entries = Object.entries(fields);
  const key = createHmac("sha256", "WebAppData")
    .update(tokens[provider])
    .digest();
  const hash = createHmac("sha256", key)
    .update(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([k, v]) => k + "=" + v)
        .join("\n"),
    )
    .digest("hex");
  return new URLSearchParams([...entries, ["hash", hash]]).toString();
};

test("messenger account access requires email confirmation, owner preview and a fresh launch", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const codes = new Map<string, string>();
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "disabled",
      EMAIL_REGISTRATION_MODE: "required",
      EMAIL_REGISTRATION_SECRET: "a".repeat(64),
      TELEGRAM_MINI_APP_BOT_TOKEN: tokens.telegram,
      MAX_MINI_APP_BOT_TOKEN: tokens.max,
    }),
    emailRegistrationDelivery: async (data) => {
      codes.set(data.email, data.code);
    },
  });
  t.after(() => app.close());
  const send = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: Record<string, string>,
    cookie?: string,
  ) =>
    app.inject({
      method,
      url,
      payload,
      headers: {
        origin: "http://localhost:3000",
        [CONTRACT_VERSION_HEADER]: "1",
        ...(cookie ? { cookie } : {}),
      },
    });
  const session = (response: { headers: { [key: string]: unknown } }) => {
    const cookie = response.headers["set-cookie"];
    assert.equal(typeof cookie, "string");
    return String(cookie).split(";")[0]!;
  };
  async function register(email: string) {
    const started = await app.inject({
      method: "POST",
      url: "/v1/auth/email/register",
      headers: {
        origin: "http://localhost:3000",
        [CONTRACT_VERSION_HEADER]: "1",
      },
      payload: { email, password, consents: await syntheticConsentsFor(app) },
    });
    assert.equal(started.statusCode, 200, started.body);
    assert.equal(started.headers["set-cookie"], undefined);
    assert.ok(codes.get(email));
    const { challengeId, proof } = started.json<{
      challengeId: string;
      proof: string;
    }>();
    const confirmed = await send("POST", "/v1/auth/email/confirm", {
      challengeId,
      proof,
      code: codes.get(email)!,
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    return {
      cookie: session(confirmed),
      id: confirmed.json<{ user: { id: string } }>().user.id,
      email,
    };
  }

  const owner = await register("owner@example.test");
  const other = await register("untrusted@example.test");

  for (const provider of ["telegram", "max"] as const) {
    const prefix = `/v1/mini-apps/${provider}`;
    const original = sign(provider);
    const unlinked = await send("POST", prefix + "/sign-in", {
      initData: original,
    });
    assert.ok(unlinked.statusCode >= 400);
    assert.equal(unlinked.headers["set-cookie"], undefined);
    const aged = await send("POST", prefix + "/sign-in", {
      initData: sign(provider, 360),
    });
    assert.equal(aged.statusCode, 400);

    const wrong = await send(
      "POST",
      prefix + "/link/prepare",
      { initData: original, password: "wrong" },
      owner.cookie,
    );
    assert.equal(wrong.statusCode, 403);
    const prepared = await send(
      "POST",
      prefix + "/link/prepare",
      { initData: original, password },
      owner.cookie,
    );
    assert.equal(prepared.statusCode, 200, prepared.body);
    const target = prepared.json<{
      id: string;
      email: string;
      confirmation: string;
    }>();
    assert.equal(target.id, owner.id);
    assert.equal(target.email, owner.email);
    const linkedBody = {
      initData: original,
      userId: target.id,
      confirmation: target.confirmation,
    };
    assert.equal(
      (await send("POST", prefix + "/link", linkedBody, other.cookie))
        .statusCode,
      409,
    );
    assert.deepEqual(
      (
        await send(
          "GET",
          "/v1/account/messenger-links",
          undefined,
          owner.cookie,
        )
      ).json(),
      { providers: [] },
    );
    assert.equal(
      (await send("POST", prefix + "/link", linkedBody, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await send("POST", prefix + "/link", linkedBody, owner.cookie))
        .statusCode,
      409,
    );
    const consumed = await send("POST", prefix + "/sign-in", {
      initData: original,
    });
    assert.equal(consumed.statusCode, 409);
    assert.equal(consumed.headers["set-cookie"], undefined);

    const launch = sign(provider);
    const active = await send(
      "POST",
      prefix + "/sign-in",
      { initData: launch },
      other.cookie,
    );
    assert.equal(active.statusCode, 409);
    const signin = await send("POST", prefix + "/sign-in", {
      initData: launch,
    });
    assert.equal(signin.statusCode, 200, signin.body);
    assert.deepEqual(signin.json(), {
      user: { id: owner.id, email: owner.email },
      purpose: "housing",
    });
    const messengerCookie = session(signin);
    assert.equal(
      (
        await send(
          "GET",
          "/v1/account/messenger-links",
          undefined,
          messengerCookie,
        )
      ).statusCode,
      200,
    );
    const repeated = await send("POST", prefix + "/sign-in", {
      initData: launch,
    });
    assert.equal(repeated.statusCode, 409);
    assert.equal(repeated.headers["set-cookie"], undefined);

    const path = `/v1/account/messenger-links/${provider}`;
    assert.equal(
      (await send("POST", path + "/revoke", undefined, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await send(
          "GET",
          "/v1/account/messenger-links",
          undefined,
          messengerCookie,
        )
      ).statusCode,
      401,
    );
    assert.deepEqual(
      (
        await send(
          "GET",
          "/v1/account/messenger-links",
          undefined,
          owner.cookie,
        )
      ).json(),
      { providers: [provider] },
    );
    const reopened = await send("POST", prefix + "/sign-in", {
      initData: sign(provider),
    });
    assert.equal(reopened.statusCode, 200);
    const reopenedCookie = session(reopened);
    assert.equal(
      (await send("DELETE", path, undefined, owner.cookie)).statusCode,
      200,
    );
    assert.equal(
      (
        await send(
          "GET",
          "/v1/account/messenger-links",
          undefined,
          reopenedCookie,
        )
      ).statusCode,
      401,
    );
    assert.deepEqual(
      (
        await send(
          "GET",
          "/v1/account/messenger-links",
          undefined,
          owner.cookie,
        )
      ).json(),
      { providers: [] },
    );
  }
});

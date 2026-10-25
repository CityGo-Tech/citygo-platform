import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  favoriteMessagesPageSchema,
} from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";

test("favorite HTTP endpoints use only the current owner, reject forgery and never call AI/payments", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  const app = await buildAppAfterMigration();
  async function buildAppAfterMigration() {
    await migrate(db);
    return buildApp({
      db,
      testing: true,
      config: readConfig({
        NODE_ENV: "test",
        DATABASE_URL: "pglite://:memory:",
        WEB_ORIGIN: "http://localhost:3000",
      }),
    });
  }
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const owner = await registerSyntheticConsentingUser(
      db,
      "owner@example.test",
      "synthetic",
    ),
    other = await registerSyntheticConsentingUser(
      db,
      "other@example.test",
      "synthetic",
    );
  const tokens = [randomUUID(), randomUUID()];
  for (const [i, id] of [owner, other].entries())
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [tokenHash(tokens[i]!), id],
    );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [owner],
    )
  ).rows[0]!.id;
  const id = (
    await db.query<{ id: string }>(
      'insert into messages(thread_id,role,content,metadata) values($1,\'user\',\'Keep my question\',\'{"agentKey":"support","status":"complete"}\') returning id::text',
      [thread],
    )
  ).rows[0]!.id;
  const call = (
    method: "GET" | "POST",
    path: string,
    token?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const path = "/v1/messages/" + id + "/favorite";
  assert.equal((await call("GET", "/v1/messages/favorites")).statusCode, 401);
  assert.equal(
    (await call("POST", path, tokens[0], { saved: true, userId: other }))
      .statusCode,
    400,
  );
  assert.equal(
    (await call("POST", path, tokens[0], { saved: "true" })).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/v1/messages/9223372036854775808/favorite",
        tokens[0],
        { saved: true },
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("POST", path, tokens[1], { saved: true })).statusCode,
    404,
    "even a super admin cannot bookmark another user's message",
  );
  assert.equal(
    (await call("POST", path, tokens[0], { saved: true })).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", path, tokens[0], { saved: true })).statusCode,
    200,
  );
  const list = await call("GET", "/v1/messages/favorites", tokens[0]);
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.headers["cache-control"], "no-store");
  assert.deepEqual(favoriteMessagesPageSchema.parse(list.json()), {
    userId: owner,
    messages: [
      {
        id,
        threadId: thread,
        role: "user",
        content: "Keep my question",
        agentKey: "support",
        status: "complete",
      },
    ],
    nextBefore: null,
  });
  assert.deepEqual(
    (await call("GET", "/v1/messages/favorites", tokens[1])).json().messages,
    [],
  );
  assert.equal(
    (await call("GET", "/v1/messages/favorites?userId=" + owner, tokens[1]))
      .statusCode,
    400,
  );
  assert.equal(
    (await call("GET", "/v1/messages/favorites?before=nope", tokens[0]))
      .statusCode,
    400,
  );
  const csrf = await app.inject({
    method: "POST",
    url: path,
    headers: {
      [CONTRACT_VERSION_HEADER]: "1",
      cookie: "citygo=" + tokens[0],
      origin: "https://foreign.example",
    },
    payload: { saved: false },
  });
  assert.equal(csrf.statusCode, 403);
  assert.equal(
    (await call("POST", path, tokens[0], { saved: false })).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", "/v1/messages/favorites", tokens[0])).json().messages
      .length,
    0,
  );
  assert.equal(
    (await db.query("select content from messages where id=$1", [id])).rows
      .length,
    1,
  );
  for (const table of [
    "ai_model_attempts",
    "ai_credit_entries",
    "payment_topup_orders",
  ])
    assert.equal((await db.query("select 1 from " + table)).rows.length, 0);
  await db.query("delete from sessions where user_id=$1", [owner]);
  assert.equal(
    (await call("GET", "/v1/messages/favorites", tokens[0])).statusCode,
    401,
  );
});

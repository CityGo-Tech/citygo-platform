import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
test("HTTP title changes require the current owner and CAS; they never enter messages/context or call external transports", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let modelCalls = 0;
  const app = await buildApp({
    db,
    testing: true,
    provider: {
      name: "openai",
      model: "synthetic/title",
      async *stream() {
        modelCalls++;
        yield { type: "delta", text: "unexpected" };
      },
    },
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
      LLM_PROVIDER: "disabled",
      YOOKASSA_MODE: "disabled",
      EMAIL_REGISTRATION_MODE: "disabled",
      PHONE_VERIFICATION_MODE: "disabled",
    }),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const repo = new Repository(db);
  const owner = await registerSyntheticConsentingUser(
      db,
      "title-owner@example.test",
      "synthetic",
      app,
    ),
    other = await registerSyntheticConsentingUser(
      db,
      "title-other@example.test",
      "synthetic",
      app,
    );
  const token = randomUUID(),
    foreignToken = randomUUID();
  await repo.createSession(owner, tokenHash(token));
  await repo.createSession(other, tokenHash(foreignToken));
  await db.query("update users set role='super_admin'where id=$1", [other]);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key,context,status)values($1,'support','support',$2::jsonb,'closed')returning id::text",
      [owner, JSON.stringify({ exact: "unchanged" })],
    )
  ).rows[0]!.id;
  const before = (
    await db.query(
      "select to_jsonb(t)as row from agent_threads t where id=$1",
      [thread],
    )
  ).rows;
  const call = (
    method: "GET" | "PATCH",
    id: string = thread,
    bearer: string = token,
    body?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url: "/v1/conversations/" + id + "/title",
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      },
      ...(body === undefined ? {} : { payload: body }),
    });
  assert.equal((await call("GET", thread, "")).statusCode, 401);
  const initial = await call("GET");
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.headers["cache-control"], "no-store");
  assert.equal(initial.json().revision, "0");
  const saved = await call("PATCH", thread, token, {
    title: "Мой план жилья",
    expectedRevision: "0",
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().revision, "1");
  assert.equal(
    (
      await call("PATCH", thread, token, {
        title: "stale",
        expectedRevision: "0",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call("PATCH", thread, token, {
        title: "forged",
        expectedRevision: "1",
        userId: other,
      })
    ).statusCode,
    400,
  );
  const foreign = await call("GET", thread, foreignToken),
    absent = await call("GET", "9223372036854775807", foreignToken);
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(foreign.json().error, absent.json().error);
  assert.equal(
    (
      await call("PATCH", thread, foreignToken, {
        title: "forged",
        expectedRevision: "1",
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("PATCH", thread, token, { title: null, expectedRevision: "1" }))
      .statusCode,
    200,
  );
  assert.deepEqual(
    (
      await db.query(
        "select to_jsonb(t)as row from agent_threads t where id=$1",
        [thread],
      )
    ).rows,
    before,
  );
  assert.equal((await db.query("select * from messages")).rows.length, 0);
  assert.equal(modelCalls, 0);
  await db.query("update users set status='blocked'where id=$1", [owner]);
  assert.equal(
    (
      await call("PATCH", thread, token, {
        title: "blocked",
        expectedRevision: "2",
      })
    ).statusCode,
    401,
  );
});

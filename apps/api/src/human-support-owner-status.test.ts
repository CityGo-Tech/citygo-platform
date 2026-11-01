import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

test("owner PATCH support request is authenticated, strict, version-bound and never dispatches a model", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let modelCalls = 0;
  const app = await buildApp({
    db,
    testing: true,
    provider: {
      name: "openai",
      model: "synthetic/never",
      async *stream() {
        modelCalls++;
        yield { type: "delta", text: "forbidden" };
      },
    },
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
      LLM_PROVIDER: "disabled",
      YOOKASSA_MODE: "disabled",
      PHONE_VERIFICATION_MODE: "disabled",
      EMAIL_REGISTRATION_MODE: "disabled",
    }),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const repo = new Repository(db);
  async function user(email: string, role = "user") {
    const id = await registerSyntheticConsentingUser(
        db,
        email,
        "synthetic",
        app,
      ),
      token = randomUUID();
    await repo.createSession(id, tokenHash(token));
    await db.query("update users set role=$2 where id=$1", [id, role]);
    return {
      id,
      headers: {
        authorization: "Bearer " + token,
        "x-citygo-client": "native",
      },
    };
  }
  const owner = await user("owner-support-api@example.test"),
    other = await user("other-support-api@example.test", "admin");
  assert.equal(
    (await app.inject({ url: "/v1/dashboard", headers: owner.headers })).json()
      .supportManagementAvailable,
    true,
  );
  const created = await app.inject({
    method: "POST",
    url: "/v1/support-requests",
    headers: owner.headers,
    payload: {
      operationId: randomUUID(),
      body: "Помогите разобраться в первом шаге переезда.",
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().request.id;
  const call = (
    headers: Record<string, string> | undefined,
    payload: Record<string, unknown>,
    suffix = "",
  ) =>
    app.inject({
      method: "PATCH",
      url: "/v1/support-requests/" + id + suffix,
      headers,
      payload,
    });
  assert.equal(
    (
      await call(
        { "x-citygo-client": "native" },
        { expectedRevision: 1, status: "closed" },
      )
    ).statusCode,
    401,
  );
  assert.equal(
    (await call(other.headers, { expectedRevision: 1, status: "closed" }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await call(owner.headers, {
        expectedRevision: 1,
        status: "closed",
        userId: other.id,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        owner.headers,
        { expectedRevision: 1, status: "closed" },
        "?owner=1",
      )
    ).statusCode,
    400,
  );
  const closed = await call(owner.headers, {
    expectedRevision: 1,
    status: "closed",
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().request.revision, 2);
  assert.equal(closed.json().userId, owner.id);
  assert.equal(closed.json().request.owner, undefined);
  assert.equal(
    (await call(owner.headers, { expectedRevision: 1, status: "open" }))
      .statusCode,
    409,
  );
  assert.equal(
    (await call(owner.headers, { expectedRevision: 2, status: "open" }))
      .statusCode,
    200,
  );
  assert.equal(modelCalls, 0);
  assert.equal(
    (await db.query("select * from ai_credit_entries")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select * from payment_topup_orders")).rows.length,
    0,
  );
});

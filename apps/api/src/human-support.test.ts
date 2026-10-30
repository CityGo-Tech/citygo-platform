import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate, Repository } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";

test("HTTP support service is independently saved, owner-scoped and admin CAS controlled with no AI/payment transport", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let modelCalls = 0;
  const app = await buildApp({
    db,
    testing: true,
    provider: {
      name: "openai",
      model: "synthetic/support",
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
  const user = async (email: string, role = "user") => {
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
  };
  const owner = await user("support-owner@example.test"),
    other = await user("support-other@example.test"),
    admin = await user("support-admin@example.test", "admin");
  const input = {
    operationId: randomUUID(),
    body: "Не понимаю, с какого шага начать переезд. Нужна помощь человека.",
  };
  const created = await app.inject({
    method: "POST",
    url: "/v1/support-requests",
    headers: owner.headers,
    payload: input,
  });
  assert.equal(created.statusCode, 200, created.body);
  const receipt = created.json();
  assert.equal(receipt.userId, owner.id);
  assert.equal(receipt.request.status, "open");
  assert.equal(created.headers["cache-control"], "no-store");
  assert.deepEqual(
    (
      await app.inject({
        method: "POST",
        url: "/v1/support-requests",
        headers: owner.headers,
        payload: input,
      })
    ).json(),
    receipt,
  );
  const foreign = await app.inject({
    url: "/v1/support-requests",
    headers: other.headers,
  });
  assert.deepEqual(foreign.json().requests, []);
  assert.equal(
    (
      await app.inject({
        url: "/v1/admin/support-requests",
        headers: owner.headers,
      })
    ).statusCode,
    403,
  );
  const detail = await app.inject({
    url: "/v1/admin/support-requests/" + receipt.request.id,
    headers: admin.headers,
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().request.owner.userId, owner.id);
  const closed = await app.inject({
    method: "PATCH",
    url: "/v1/admin/support-requests/" + receipt.request.id,
    headers: admin.headers,
    payload: { expectedRevision: 1, status: "closed" },
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().request.status, "closed");
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: "/v1/admin/support-requests/" + receipt.request.id,
        headers: admin.headers,
        payload: { expectedRevision: 1, status: "open" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/support-requests",
        headers: { origin: "https://invalid.example" },
        payload: input,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: "/v1/support-requests" })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/support-requests",
        headers: owner.headers,
        payload: { ...input, operationId: randomUUID(), userId: other.id },
      })
    ).statusCode,
    400,
  );
  for (const body of ["😀".repeat(10), "a".repeat(20) + "\0"]) {
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/support-requests",
      headers: owner.headers,
      payload: { operationId: randomUUID(), body },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  const astral = await app.inject({
    method: "POST",
    url: "/v1/support-requests",
    headers: owner.headers,
    payload: { operationId: randomUUID(), body: "😀".repeat(4000) },
  });
  assert.equal(astral.statusCode, 200, astral.body);
  assert.equal(astral.json().request.body, "😀".repeat(4000));
  await db.query("update users set must_change_password=true where id=$1", [
    owner.id,
  ]);
  assert.equal(
    (await app.inject({ url: "/v1/support-requests", headers: owner.headers }))
      .statusCode,
    403,
  );
  await db.query("update users set role='user' where id=$1", [admin.id]);
  assert.equal(
    (
      await app.inject({
        url: "/v1/admin/support-requests/" + receipt.request.id,
        headers: admin.headers,
      })
    ).statusCode,
    403,
  );
  assert.equal(modelCalls, 0);
  for (const table of [
    "messages",
    "chat_requests",
    "ai_credit_entries",
    "payment_topup_orders",
  ])
    assert.equal(
      (await db.query(`select * from ${table}`)).rows.length,
      0,
      table,
    );
  assert.equal((await app.inject({ url: "/ready" })).statusCode, 200);
});

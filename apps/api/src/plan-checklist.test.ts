import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { connectDatabase, migrate, Repository, PersonalPlan } from "@citygo/db";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
test("HTTP private checklists require current authenticated ownership, strict CAS and same-origin writes without AI or payments", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let calls = 0;
  const app = await buildApp({
    db,
    testing: true,
    provider: {
      name: "openai",
      model: "synthetic/no-calls",
      async *stream() {
        calls++;
        yield { type: "delta", text: "Unexpected" };
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
      AI_CREDIT_MODE: "routerai_citygo_10x",
      AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    }),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const owner = await registerSyntheticConsentingUser(
      db,
      "checklist-http@example.test",
      "synthetic",
      app,
    ),
    other = await registerSyntheticConsentingUser(
      db,
      "other-checklist-http@example.test",
      "synthetic",
      app,
    );
  await db.query("update users set role='super_admin' where id=$1", [other]);
  const repo = new Repository(db),
    token = randomUUID(),
    otherToken = randomUUID();
  await repo.createSession(owner, tokenHash(token));
  await repo.createSession(other, tokenHash(otherToken));
  const step = (
    await new PersonalPlan(db).create(owner, {
      operationId: randomUUID(),
      sourceMessageId: null,
      title: "Свой шаг",
      details: "",
    })
  ).item;
  const url = "/v1/personal-plan/" + step.id + "/checklist";
  const request = (
    method: "GET" | "PUT",
    payload?: object,
    credential: string = token,
    origin?: string,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        ...(origin
          ? { cookie: "citygo=" + credential, origin }
          : {
              "x-citygo-client": "native",
              ...(credential ? { authorization: "Bearer " + credential } : {}),
            }),
      },
      ...(payload ? { payload } : {}),
    });
  assert.equal((await request("GET", undefined, "")).statusCode, 401);
  assert.equal((await request("GET", undefined, otherToken)).statusCode, 404);
  const entry = {
    id: randomUUID(),
    title: "Платежи",
    details: "Что входит в сумму",
    completed: false,
  };
  assert.equal(
    (
      await request(
        "PUT",
        { expectedRevision: 1, entries: [entry] },
        token,
        "https://foreign.example.test",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request("PUT", {
        expectedRevision: 1,
        entries: [entry],
        unexpected: true,
      })
    ).statusCode,
    400,
  );
  const saved = await request("PUT", { expectedRevision: 1, entries: [entry] });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().revision, 2);
  assert.deepEqual(saved.json().entries, [entry]);
  assert.equal(
    (await request("PUT", { expectedRevision: 1, entries: [] })).statusCode,
    409,
  );
  assert.equal((await request("GET")).json().entries[0].title, "Платежи");
  const full = Array.from({ length: 20 }, (_, index) => ({
    id: randomUUID(),
    title: "Пункт " + index,
    details: "я".repeat(1000),
    completed: false,
  }));
  const fullSaved = await request("PUT", {
    expectedRevision: 2,
    entries: full,
  });
  assert.equal(fullSaved.statusCode, 200);
  assert.equal(fullSaved.json().revision, 3);
  assert.deepEqual(fullSaved.json().entries, full);
  const oversized = await request("PUT", {
    expectedRevision: 3,
    entries: [{ ...entry, details: "я".repeat(150000) }],
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal((await request("GET")).json().revision, 3);
  assert.deepEqual((await request("GET")).json().entries, full);
  await db.query("update users set must_change_password=true where id=$1", [
    owner,
  ]);
  assert.equal(
    (await request("PUT", { expectedRevision: 2, entries: [] })).statusCode,
    403,
  );
  await db.query(
    "update users set must_change_password=false,status='blocked' where id=$1",
    [owner],
  );
  assert.equal((await request("GET")).statusCode, 401);
  assert.equal(calls, 0);
  assert.equal(
    (await db.query("select * from payment_topup_orders")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select * from ai_credit_entries")).rows.length,
    0,
  );
});

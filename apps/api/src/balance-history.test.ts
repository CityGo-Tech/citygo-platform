import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  AiCreditLedger,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
test("balance history GET is strict, no-store, session-bound and owner-only without model/payment/SMS writes", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const app = await buildApp({
    db,
    testing: true,
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
  const repo = new Repository(db),
    ledger = new AiCreditLedger(db);
  const user = async (email: string) => {
    const id = await registerSyntheticConsentingUser(
        db,
        email,
        "synthetic",
        app,
      ),
      token = randomUUID();
    await repo.createSession(id, tokenHash(token));
    return {
      id,
      token,
      headers: {
        authorization: "Bearer " + token,
        "x-citygo-client": "native",
      },
    };
  };
  const owner = await user("http-history-owner@example.test"),
    other = await user("http-history-other@example.test");
  await ledger.grantWelcome(owner.id, other.id);
  const before = (await db.query("select * from ai_credit_entries")).rows;
  const read = await app.inject({
    url: "/v1/ai/credit/history?filter=gift",
    headers: owner.headers,
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.headers["cache-control"], "no-store");
  assert.equal(read.json().userId, owner.id);
  assert.equal(read.json().entries[0].amountMicros, 500_000_000);
  assert.deepEqual(
    (
      await app.inject({ url: "/v1/ai/credit/history", headers: other.headers })
    ).json().entries,
    [],
  );
  for (const query of [
    "filter=hold",
    "userId=" + other.id,
    "limit=1000",
    "cursor=bad",
    "filter=gift&filter=topup",
  ])
    assert.equal(
      (
        await app.inject({
          url: "/v1/ai/credit/history?" + query,
          headers: owner.headers,
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (await app.inject({ url: "/v1/ai/credit/history" })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/ai/credit/history",
        headers: owner.headers,
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(
    (await db.query("select * from ai_credit_entries")).rows,
    before,
  );
  for (const table of [
    "messages",
    "chat_requests",
    "payment_topup_orders",
    "payment_refunds",
    "phone_verification_challenges",
  ])
    assert.equal((await db.query(`select * from ${table}`)).rows.length, 0);
  await db.query("update users set status='blocked' where id=$1", [owner.id]);
  assert.equal(
    (await app.inject({ url: "/v1/ai/credit/history", headers: owner.headers }))
      .statusCode,
    401,
  );
  await repo.logout(tokenHash(other.token));
  assert.equal(
    (await app.inject({ url: "/v1/ai/credit/history", headers: other.headers }))
      .statusCode,
    401,
  );
});

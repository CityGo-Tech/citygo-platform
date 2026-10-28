import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connectDatabase, migrate } from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  adminCustomerAccountResponseSchema,
  adminCustomerMessagesResponseSchema,
  adminCustomerFunnelResponseSchema,
  customerAnalyticsIdentityResponseSchema,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import {
  customerAnalyticsId,
  serializeRequestLog,
} from "./customer-observability.js";

test("request logs omit contact search terms and cursor query values", () => {
  assert.deepEqual(
    serializeRequestLog({
      method: "GET",
      url: "/v1/admin/customer-accounts?search=private%40example.test",
      hostname: "localhost",
      ip: "127.0.0.1",
    }),
    {
      method: "GET",
      url: "/v1/admin/customer-accounts",
      host: "localhost",
      remoteAddress: "127.0.0.1",
    },
  );
});

async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      DATABASE_URL: "pglite://:memory:",
      WEB_ORIGIN: "http://localhost:3000",
    }),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const accounts = [];
  for (const email of [
    "observer@example.test",
    "customer@example.test",
    "ordinary-admin@example.test",
  ]) {
    const id = await registerSyntheticConsentingUser(
        db,
        email,
        "synthetic",
        app,
      ),
      token = randomUUID();
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at)values($1,$2,clock_timestamp()+interval'1 day')",
      [tokenHash(token), id],
    );
    accounts.push({ id, token });
  }
  const [observer, customer, ordinaryAdmin] = accounts as [
    { id: string; token: string },
    { id: string; token: string },
    { id: string; token: string },
  ];
  await db.query("update users set role='super_admin'where id=$1", [
    observer.id,
  ]);
  await db.query("update users set role='admin'where id=$1", [
    ordinaryAdmin.id,
  ]);
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,status)values($1,'support','closed')returning id::text",
      [customer.id],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content,metadata)values($1,'user','Приватный вопрос','{\"api_key\":\"NEVER_EXPOSE_INTERNAL_METADATA\"}'),($1,'assistant','Приватный ответ','{}'),($1,'tool','NEVER_EXPOSE_INTERNAL_TOOL','{}')",
    [thread],
  );
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
  return { db, app, observer, customer, ordinaryAdmin, thread, call };
}

test("administrative customer routes require current super-admin and never impersonate owner or expose internal records", async (t) => {
  const f = await fixture(t),
    base = "/v1/admin/customer-accounts/" + f.customer.id;
  const paths = [
    "/v1/admin/customer-accounts",
    base,
    base + "/conversations",
    base + "/conversations/" + f.thread + "/messages",
    base + "/activity",
    base + "/favorites",
    base + "/plan",
    "/v1/admin/customer-funnel",
  ];
  for (const path of paths) {
    assert.equal((await f.call("GET", path)).statusCode, 401, path);
    assert.equal(
      (await f.call("GET", path, f.customer.token)).statusCode,
      403,
      path,
    );
    assert.equal(
      (await f.call("GET", path, f.ordinaryAdmin.token)).statusCode,
      403,
      path,
    );
  }
  const account = await f.call("GET", base, f.observer.token);
  assert.equal(account.statusCode, 200);
  assert.equal(account.headers["cache-control"], "no-store");
  assert.equal(account.headers["set-cookie"], undefined);
  assert.equal(
    adminCustomerAccountResponseSchema.parse(account.json()).account.userId,
    f.customer.id,
  );
  const response = await f.call(
    "GET",
    base + "/conversations/" + f.thread + "/messages",
    f.observer.token,
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    adminCustomerMessagesResponseSchema
      .parse(response.json())
      .messages.map((m) => m.content),
    ["Приватный вопрос", "Приватный ответ"],
  );
  for (const forbidden of [
    "password_hash",
    "token_hash",
    "api_key",
    "NEVER_EXPOSE_INTERNAL_METADATA",
    "NEVER_EXPOSE_INTERNAL_TOOL",
  ])
    assert(
      !account.body.includes(forbidden) && !response.body.includes(forbidden),
    );
  const funnel = await f.call(
    "GET",
    "/v1/admin/customer-funnel",
    f.observer.token,
  );
  assert.equal(funnel.statusCode, 200);
  assert.equal(
    adminCustomerFunnelResponseSchema.parse(funnel.json()).basis,
    "registered_cohort",
  );
  assert.equal(
    (
      await f.call(
        "GET",
        "/v1/conversations/" + f.thread + "/messages",
        f.observer.token,
      )
    ).statusCode,
    404,
    "ordinary owner API remains scoped to the administrator's own account",
  );
  assert.equal(
    (await f.call("GET", base + "?secret=discard", f.observer.token))
      .statusCode,
    200,
    "no confidential query value is emitted in a DTO",
  );
  await f.db.query("update users set role='admin'where id=$1", [f.observer.id]);
  assert.equal((await f.call("GET", base, f.observer.token)).statusCode, 403);
  await f.db.query("update users set role='super_admin'where id=$1", [
    f.observer.id,
  ]);
  await f.db.query("delete from sessions where token_hash=$1", [
    tokenHash(f.observer.token),
  ]);
  assert.equal((await f.call("GET", base, f.observer.token)).statusCode, 401);
  const audited = (
    await f.db.query<{ payload: unknown }>(
      "select payload from audit_log where action='customer-account-viewed'",
    )
  ).rows;
  assert(audited.length >= 3);
  assert(!JSON.stringify(audited).includes("Приватный"));
});

test("product telemetry is own-account, allowlisted, bounded and never accepts payment/gift success or raw parameters", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call("POST", "/v1/analytics/events", undefined, {
        event: "wallet_opened",
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/analytics/events", f.customer.token, {
        event: "wallet_opened",
        userId: f.observer.id,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/analytics/events", f.customer.token, {
        event: "gift_granted",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call("POST", "/v1/analytics/events", f.customer.token, {
        event: "profile_opened",
        message: "SECRET_TEXT",
      })
    ).statusCode,
    400,
  );
  const event = await f.call("POST", "/v1/analytics/events", f.customer.token, {
    event: "wallet_opened",
  });
  assert.equal(event.statusCode, 200);
  assert.deepEqual(event.json(), { recorded: true });
  const saved = (
    await f.db.query<{ user_id: string; name: string }>(
      "select user_id::text,name from analytics_events where name like'ui_%'",
    )
  ).rows;
  assert.deepEqual(saved, [
    { user_id: f.customer.id, name: "ui_wallet_opened" },
  ]);
  const identity = await f.call(
    "GET",
    "/v1/analytics/identity",
    f.customer.token,
  );
  assert.equal(identity.statusCode, 200);
  assert.equal(identity.headers["cache-control"], "no-store");
  assert.deepEqual(
    customerAnalyticsIdentityResponseSchema.parse(identity.json()),
    { analyticsUserId: null },
  );
  assert.equal((await f.call("GET", "/v1/analytics/identity")).statusCode, 401);
});

test("telemetry rate limit stops repeated ingestion without changing accounts or finance", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++)
    assert.equal(
      (
        await f.call("POST", "/v1/analytics/events", f.customer.token, {
          event: "wallet_opened",
        })
      ).statusCode,
      200,
    );
  assert.equal(
    (
      await f.call("POST", "/v1/analytics/events", f.customer.token, {
        event: "wallet_opened",
      })
    ).statusCode,
    429,
  );
  assert.equal(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int as n from analytics_events where name='ui_wallet_opened'",
      )
    ).rows[0]!.n,
    60,
  );
  assert.equal(
    (
      await f.db.query<{ n: number }>(
        "select count(*)::int as n from ai_credit_entries",
      )
    ).rows[0]!.n,
    0,
  );
});

test("analytics identity uses a separate keyed purpose, is stable per account and reveals no contact or raw account ID", () => {
  const key = "synthetic-existing-secret-for-local-test-only-0123456789";
  const one = customerAnalyticsId("123456789012345678", key);
  assert.match(one!, /^cga_[a-f0-9]{64}$/);
  assert.equal(one, customerAnalyticsId("123456789012345678", key));
  assert.notEqual(one, customerAnalyticsId("2", key));
  assert.notEqual(
    one,
    customerAnalyticsId("123456789012345678", key + "other"),
  );
  assert(!one!.includes("123456789012345678"));
  assert.equal(customerAnalyticsId("1"), null);
});

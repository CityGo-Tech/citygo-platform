import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  connectDatabase,
  migrate,
  DomainError,
  AiCreditLedger,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { RouterAIProvider } from "@citygo/llm";
import {
  topupOrderSchema,
  type AiCredit,
  type TopupOrder,
} from "@citygo/contracts";
import { buildApp } from "./app.js";
import { YooKassaTestClient } from "./yookassa.js";

const origin = "https://pilot.example.test";
const shop = "123456";
const key = "test_SYNTHETIC-NOT-A-REAL-KEY";
function settings() {
  return readConfig({
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    YOOKASSA_MODE: "test",
    YOOKASSA_SHOP_ID: shop,
    YOOKASSA_SECRET_KEY: key,
    WEB_ORIGIN: origin,
  });
}
async function fixture(enabled = true) {
  const actual = await connectDatabase("pglite://:memory:");
  await migrate(actual);
  const state = {
    posts: 0,
    gets: 0,
    failCreate: false,
    failFinish: false,
    createStatus: "pending",
    getStatus: "pending",
    patch: {} as Record<string, unknown>,
    httpFailure: undefined as { status: number; body: unknown } | undefined,
  };
  const posted: {
    orderId: string;
    body: unknown;
    idempotence: string | null;
  }[] = [];
  const payments = new Map<
    string,
    {
      id: string;
      body: {
        amount: { value: string; currency: string };
        metadata: { citygo_order_id: string };
      };
    }
  >();
  const db: Database = {
    ...actual,
    transaction: (work) =>
      actual.transaction((tx) =>
        work({
          ...tx,
          query: async <T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) => {
            if (
              state.failFinish &&
              sql.startsWith(
                "update payment_topup_orders set provider_payment_id",
              ) &&
              params?.[3] === "succeeded"
            ) {
              state.failFinish = false;
              throw new Error("PRIVATE synthetic post-ledger failure");
            }
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  const client = new YooKassaTestClient({
    shopId: shop,
    secretKey: key,
    fetch: async (url, init) => {
      let record: {
        id: string;
        body: {
          amount: { value: string; currency: string };
          metadata: { citygo_order_id: string };
        };
      };
      let status: string;
      if (init?.method === "POST") {
        state.posts++;
        const body = JSON.parse(String(init.body));
        const stored = (
          await actual.query<{ create_payload: unknown }>(
            "select create_payload from payment_topup_orders where id=$1",
            [body.metadata.citygo_order_id],
          )
        ).rows[0];
        assert.ok(stored, "order must exist before HTTP POST");
        assert.deepEqual(
          stored.create_payload,
          body,
          "network payload must exactly equal the frozen DB request",
        );
        const previous = payments.get(body.metadata.citygo_order_id);
        record = previous ?? { id: randomUUID(), body };
        payments.set(body.metadata.citygo_order_id, record);
        posted.push({
          orderId: body.metadata.citygo_order_id,
          body,
          idempotence: new Headers(init.headers).get("Idempotence-Key"),
        });
        if (state.failCreate) {
          state.failCreate = false;
          throw new Error("PRIVATE ambiguous create " + key);
        }
        status = state.createStatus;
      } else {
        state.gets++;
        const id = String(url).split("/").at(-1)!;
        const found = [...payments.values()].find((entry) => entry.id === id);
        assert.ok(found);
        record = found;
        status = state.getStatus;
      }
      if (state.httpFailure)
        return new Response(JSON.stringify(state.httpFailure.body), {
          status: state.httpFailure.status,
          headers: { "Content-Type": "application/json" },
        });
      return new Response(
        JSON.stringify({
          id: record.id,
          status,
          paid: status === "succeeded" || status === "waiting_for_capture",
          test: true,
          amount: record.body.amount,
          metadata: record.body.metadata,
          recipient: { account_id: shop },
          confirmation: {
            type: "redirect",
            confirmation_url:
              "https://yoomoney.ru/checkout/payments/v2/contract?orderId=" +
              record.id,
          },
          ...state.patch,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const config = enabled
    ? settings()
    : readConfig({
        NODE_ENV: "test",
        LLM_PROVIDER: "disabled",
        AI_CREDIT_MODE: "routerai_citygo_10x",
        WEB_ORIGIN: origin,
      });
  const app = await buildApp({
    db,
    config,
    testing: true,
    ...(enabled ? { paymentClient: client } : {}),
  });
  const call = (
    method: "GET" | "POST",
    path: string,
    token = "",
    body?: object,
    from = origin,
  ) =>
    app.inject({
      method,
      url: path,
      headers: { origin: from, cookie: "citygo=" + token },
      ...(body !== undefined ? { payload: body } : {}),
    });
  async function signup() {
    const result = await call("POST", "/v1/auth/register", "", {
      email: randomUUID() + "@example.test",
      password: "abcdef",
    });
    assert.equal(result.statusCode, 200, result.body);
    const token = result.cookies[0]!.value;
    const user = result.json().user;
    return { token, id: String(user.id) };
  }
  const user = await signup(),
    other = await signup();
  const create = (requestId = randomUUID(), amountKopeks = 10_001) =>
    call("POST", "/v1/payments/topups", user.token, {
      requestId,
      amountKopeks,
    });
  const get = (id: string, token = user.token) =>
    call("GET", "/v1/payments/topups/" + id, token);
  const reconcile = (id: string, token = user.token, body: object = {}) =>
    call("POST", `/v1/payments/topups/${id}/reconcile`, token, body);
  const balance = async () =>
    (await call("GET", "/v1/ai/credit", user.token)).json<AiCredit>();
  return {
    actual,
    db,
    state,
    posted,
    payments,
    client,
    config,
    app,
    user,
    other,
    call,
    create,
    get,
    reconcile,
    balance,
    async close() {
      await app.close();
      await actual.close();
    },
  };
}
function order(body: string): TopupOrder {
  return topupOrderSchema.parse(JSON.parse(body));
}

test("provider create refusal logs only safe diagnostics and preserves generic503 without retry or credit", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const warnings: unknown[][] = [];
  t.mock.method(f.app.log, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  f.state.httpFailure = {
    status: 400,
    body: {
      type: "error",
      code: "invalid_request",
      parameter: "receipt",
      id: "PRIVATE-PROVIDER-ID",
      description: "PRIVATE " + key,
      customer: { email: "PRIVATE@example.test" },
      headers: { authorization: key },
      confirmation_url: "https://PRIVATE.example.test/pay",
    },
  };
  const result = await f.create();
  assert.equal(result.statusCode, 503);
  assert.equal(
    result.json().error,
    "Не удалось проверить платёж. Повторите проверку состояния, не создавайте новый платёж.",
  );
  assert.deepEqual(warnings, [
    [
      {
        event: "yookassa_operation_failed",
        operation: "create_payment",
        failureClass: "http",
        httpStatus: 400,
        providerCode: "invalid_request",
        parameter: "receipt",
      },
      "YooKassa operation failed",
    ],
  ]);
  assert.doesNotMatch(
    result.body + JSON.stringify(warnings),
    /PRIVATE|SYNTHETIC|Authorization|https:/,
  );
  assert.doesNotMatch(result.body, /invalid_request|receipt|providerCode/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
  assert.equal((await f.balance()).availableMicros, 0);
  assert.deepEqual(
    (
      await f.actual.query(
        "select status,provider_payment_id,confirmation_url from payment_topup_orders",
      )
    ).rows,
    [{ status: "queued", provider_payment_id: null, confirmation_url: null }],
  );
});

test("provider settlement refusal logs a literal get operation without leaking fields or repeating POST", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = order((await f.create()).body);
  const before = (await f.actual.query("select * from payment_topup_orders"))
    .rows;
  const warnings: unknown[][] = [];
  t.mock.method(f.app.log, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  f.state.httpFailure = {
    status: 503,
    body: {
      type: "error",
      code: "PRIVATE " + key,
      parameter: "PRIVATE@example.test",
      description: "PRIVATE",
    },
  };
  const result = await f.reconcile(created.orderId);
  assert.equal(result.statusCode, 503);
  assert.deepEqual(warnings, [
    [
      {
        event: "yookassa_operation_failed",
        operation: "get_payment",
        failureClass: "http",
        httpStatus: 503,
        providerCode: "unrecognized",
        parameter: "unrecognized",
      },
      "YooKassa operation failed",
    ],
  ]);
  assert.doesNotMatch(
    result.body + JSON.stringify(warnings),
    /PRIVATE|SYNTHETIC|Authorization|https:/,
  );
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 1);
  assert.equal((await f.balance()).availableMicros, 0);
  assert.deepEqual(
    (await f.actual.query("select * from payment_topup_orders")).rows,
    before,
  );
});

test("diagnostic logger failure cannot change public refusal, retry or monetary state", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.httpFailure = {
    status: 400,
    body: { code: "invalid_request", parameter: "receipt" },
  };
  t.mock.method(f.app.log, "warn", () => {
    throw new Error("PRIVATE logger failure");
  });
  const result = await f.create();
  assert.equal(result.statusCode, 503);
  assert.doesNotMatch(result.body, /PRIVATE|receipt|invalid_request/);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
  assert.equal((await f.balance()).availableMicros, 0);
});

test("disabled payment capability remains false in direct balance and dashboard; endpoints cannot create orders", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  assert.equal((await f.balance()).topUpAvailable, false);
  const board = (await f.call("GET", "/v1/dashboard", f.user.token)).json();
  assert.equal(board.aiAccess.credit.topUpAvailable, false);
  assert.equal((await f.create()).statusCode, 503);
  assert.equal(
    (await f.actual.query("select * from payment_topup_orders")).rows.length,
    0,
  );
});

test("owned checkout persists frozen payload before HTTP, read-only GET and server GET credit exactly 1:1 once", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const first = await f.create();
  assert.equal(first.statusCode, 200, first.body);
  const created = order(first.body);
  assert.equal(created.status, "pending");
  assert.equal(created.credited, false);
  assert.equal(created.creditMicros, 100_010_000);
  assert.equal(f.posted[0]!.idempotence, created.orderId);
  assert.equal((await f.balance()).availableMicros, 0);
  assert.equal((await f.balance()).topUpAvailable, true);
  assert.equal(
    (await f.call("GET", "/v1/dashboard", f.user.token)).json().aiAccess.credit
      .topUpAvailable,
    true,
  );
  const before = await f.actual.query("select * from payment_topup_orders");
  assert.equal((await f.get(created.orderId)).statusCode, 200);
  assert.deepEqual(
    (await f.actual.query("select * from payment_topup_orders")).rows,
    before.rows,
  );
  assert.equal(f.state.gets, 0);
  assert.equal(
    order((await f.reconcile(created.orderId)).body).credited,
    false,
  );
  f.state.getStatus = "succeeded";
  const results = await Promise.all(
    Array.from({ length: 7 }, () => f.reconcile(created.orderId)),
  );
  for (const reply of results) {
    assert.equal(reply.statusCode, 200, reply.body);
    assert.equal(order(reply.body).credited, true);
  }
  assert.equal((await f.balance()).availableMicros, 100_010_000);
  assert.equal(
    (await f.actual.query("select * from ai_credit_topups")).rows.length,
    1,
  );
  assert.equal(
    (await f.actual.query("select * from ai_credit_entries where kind='topup'"))
      .rows.length,
    1,
  );
  assert.doesNotMatch(
    first.body,
    /SYNTHETIC|merchantId|providerPaymentId|createPayload|userId/,
  );
});

test("an immediate create succeeded response is bound pending and never credits without a separate server GET", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.createStatus = "succeeded";
  const created = order((await f.create()).body);
  assert.equal(created.status, "pending");
  assert.equal(created.credited, false);
  assert.equal(f.state.gets, 0);
  assert.equal((await f.balance()).grantedMicros, 0);
  f.state.getStatus = "waiting_for_capture";
  assert.equal(
    order((await f.reconcile(created.orderId)).body).credited,
    false,
  );
  assert.equal((await f.balance()).grantedMicros, 0);
  f.state.getStatus = "succeeded";
  assert.equal(order((await f.reconcile(created.orderId)).body).credited, true);
});

test("auth, temporary-password gate, Origin and ownership block writes or provider calls", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal(
    (
      await f.call("POST", "/v1/payments/topups", "", {
        requestId: randomUUID(),
        amountKopeks: 100,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/payments/topups",
        f.user.token,
        { requestId: randomUUID(), amountKopeks: 100 },
        "https://foreign.example.test",
      )
    ).statusCode,
    403,
  );
  await f.actual.query(
    "update users set must_change_password=true where id=$1",
    [f.user.id],
  );
  assert.equal((await f.create()).statusCode, 403);
  await f.actual.query(
    "update users set must_change_password=false where id=$1",
    [f.user.id],
  );
  assert.equal(
    (
      await f.call("POST", "/v1/payments/topups", f.user.token, {
        requestId: randomUUID(),
        amountKopeks: 100,
        userId: f.other.id,
      })
    ).statusCode,
    400,
  );
  const created = order((await f.create()).body);
  assert.equal((await f.get(created.orderId, f.other.token)).statusCode, 404);
  assert.equal(
    (await f.reconcile(created.orderId, f.other.token)).statusCode,
    404,
  );
  assert.equal(
    (await f.reconcile(created.orderId, f.user.token, { paid: true }))
      .statusCode,
    400,
  );
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
});

test("ambiguous create retries reuse one persisted order, exact body and provider key", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const requestId = randomUUID();
  f.state.failCreate = true;
  const failed = await f.create(requestId);
  assert.equal(failed.statusCode, 503);
  assert.doesNotMatch(failed.body, /PRIVATE|SYNTHETIC/);
  assert.equal(
    (await f.actual.query("select * from payment_topup_orders")).rows.length,
    1,
  );
  const retried = await f.create(requestId);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(f.state.posts, 2);
  assert.deepEqual(f.posted[0], f.posted[1]);
  assert.equal((await f.create(requestId)).statusCode, 200);
  assert.equal(f.state.posts, 2);
  assert.equal((await f.create(requestId, 10_002)).statusCode, 409);
  assert.equal(f.state.posts, 2);
});

test("provider amount, mode, merchant or order mismatches never post a balance", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = order((await f.create()).body);
  f.state.getStatus = "succeeded";
  for (const patch of [
    { test: false },
    { recipient: { account_id: "654321" } },
    { metadata: { citygo_order_id: randomUUID() } },
    { amount: { value: "100.02", currency: "RUB" } },
    { paid: false },
    { refunded_amount: { value: "0.01", currency: "RUB" } },
  ]) {
    f.state.patch = patch;
    const reply = await f.reconcile(created.orderId);
    assert.equal(reply.statusCode, 503, reply.body);
    assert.doesNotMatch(reply.body, /SYNTHETIC|654321/);
    assert.equal((await f.balance()).grantedMicros, 0);
  }
  assert.equal(
    (await f.actual.query("select * from ai_credit_topups")).rows.length,
    0,
  );
});

test("canceling a test payment never credits and repeated observations do not call the provider", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = order((await f.create()).body);
  f.state.getStatus = "canceled";
  assert.equal(
    order((await f.reconcile(created.orderId)).body).status,
    "canceled",
  );
  assert.equal(
    order((await f.reconcile(created.orderId)).body).credited,
    false,
  );
  assert.equal(f.state.gets, 1);
  assert.equal((await f.balance()).grantedMicros, 0);
});

test("a ledger commit followed by order-projection failure remains readable and cannot double-credit", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = order((await f.create()).body);
  f.state.getStatus = "succeeded";
  f.state.failFinish = true;
  assert.equal((await f.reconcile(created.orderId)).statusCode, 500);
  assert.equal((await f.balance()).availableMicros, 100_010_000);
  const observed = await f.get(created.orderId);
  assert.equal(order(observed.body).credited, true);
  assert.equal(order(observed.body).status, "succeeded");
  assert.equal(order((await f.reconcile(created.orderId)).body).credited, true);
  assert.equal(
    (await f.actual.query("select * from ai_credit_topups")).rows.length,
    1,
  );
});

test("changed configured merchant rejects owned orders before provider I/O", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = order((await f.create()).body);
  const app = await buildApp({
    db: f.db,
    config: { ...f.config, YOOKASSA_SHOP_ID: "654321" },
    testing: true,
    paymentClient: f.client,
  });
  t.after(() => app.close());
  for (const method of ["GET", "POST"] as const) {
    const reply = await app.inject({
      method,
      url: `/v1/payments/topups/${created.orderId}${method === "POST" ? "/reconcile" : ""}`,
      headers: { origin, cookie: "citygo=" + f.user.token },
      ...(method === "POST" ? { payload: {} } : {}),
    });
    assert.equal(reply.statusCode, 409, reply.body);
  }
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
});

test("old uncertain creates become review-required with no POST replay after 23 hours", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const id = randomUUID(),
    requestId = randomUUID();
  const payload = {
    amount: { value: "100.01", currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: origin + "/" },
    metadata: { citygo_order_id: id },
    description: "Пополнение тестового баланса CityGo",
  };
  await f.actual.query(
    "insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload,created_at,updated_at) values ($1,$2,$3,10001,$4,true,$5,$6,clock_timestamp()-interval '23 hours',clock_timestamp()-interval '23 hours')",
    [id, f.user.id, requestId, shop, origin + "/", JSON.stringify(payload)],
  );
  const reply = await f.create(requestId);
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(order(reply.body).status, "review_required");
  assert.equal(f.state.posts, 0);
  assert.equal(order((await f.reconcile(id)).body).status, "review_required");
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
});

test("injected unsafe config or clients are rejected before touching any database", async () => {
  let touched = false;
  const touch = async () => {
    touched = true;
    throw new Error("Must not touch DB");
  };
  const db = {
    query: touch,
    exec: touch,
    transaction: touch,
    close: touch,
  } as unknown as Database;
  const paymentClient = { create: touch, get: touch };
  for (const patch of [
    { NODE_ENV: "production" },
    { LLM_PROVIDER: "routerai" },
    { AI_CREDIT_MODE: "disabled" },
    { YOOKASSA_SECRET_KEY: "live_PRIVATE" },
    { WEB_ORIGIN: "http://localhost:3000" },
  ]) {
    await assert.rejects(
      buildApp({
        db,
        config: { ...settings(), ...patch } as ReturnType<typeof readConfig>,
        testing: true,
        paymentClient,
      }),
    );
    assert.equal(touched, false);
  }
  await assert.rejects(
    buildApp({ db, config: settings(), testing: false, paymentClient }),
  );
  await assert.rejects(
    buildApp({
      db,
      config: { ...settings(), NODE_ENV: "development" },
      testing: true,
      paymentClient,
    }),
  );
  await assert.rejects(
    buildApp({
      db,
      config: settings(),
      testing: true,
      paymentClient,
      providers: { routerai: {} as never },
    }),
  );
  assert.equal(touched, false);
});

test("test checkout quarantines the database across app recreation with payments disabled", async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.create()).statusCode, 200);
  let providerCalls = 0;
  const provider = new RouterAIProvider("synthetic-only", "test/model", {
    upstream: "test-upstream",
    fetch: async () => {
      providerCalls++;
      throw new Error("Synthetic network must remain unused");
    },
  });
  await assert.rejects(
    buildApp({
      db: f.db,
      config: {
        ...f.config,
        YOOKASSA_MODE: "disabled",
        LLM_PROVIDER: "routerai",
        ROUTERAI_MODEL: "test/model",
        ROUTERAI_UPSTREAM: "test-upstream",
      },
      testing: true,
      provider,
    }),
    (error: unknown) =>
      error instanceof DomainError && error.statusCode === 503,
  );
  assert.equal(providerCalls, 0);
  assert.equal(
    (await f.actual.query("select * from ai_model_attempts")).rows.length,
    0,
  );
  assert.equal(
    (await f.actual.query("select * from ai_credit_topups")).rows.length,
    0,
  );
});

test("test checkout cannot advertise availability on a database already admitted to live-mode credit", async (t) => {
  const f = await fixture(false);
  t.after(f.close);
  // Entirely synthetic local proof; no actual payment or provider is contacted.
  await new AiCreditLedger(f.db).topUpConfirmed(f.user.id, randomUUID(), {
    providerPaymentId: randomUUID(),
    paidKopeks: 100,
    merchantId: "synthetic-live-mode",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  await assert.rejects(
    buildApp({
      db: f.db,
      config: settings(),
      testing: true,
      paymentClient: f.client,
    }),
    (error: unknown) =>
      error instanceof DomainError && error.statusCode === 409,
  );
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.equal(
    (await f.actual.query("select * from payment_topup_orders")).rows.length,
    0,
  );
});

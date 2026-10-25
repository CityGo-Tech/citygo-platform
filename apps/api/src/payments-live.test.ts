import { syntheticServiceConsents } from "./test-service-consents.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  topupOrderSchema,
  ownerPaymentSourceListSchema,
  type AiCredit,
} from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  DomainError,
  PaymentAdmission,
  PaymentTopupOrders,
  type Database,
  type PaymentRefundDispatchInput,
  type PaymentRefundObservation,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { YooKassaClient } from "./yookassa.js";
import { createPaymentAdmissionBinding } from "./payment-admission.js";
import { tokenHash } from "./auth.js";

// Entirely local synthetic merchant. The real transport is exercised through an
// injected fetch, never the network, a .env file, a real key, AI or a payment API.
const origin = "https://pilot.example.test";
const shop = "123456";
function settings(mode: "live" | "test" = "live") {
  return readConfig({
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    YOOKASSA_MODE: mode,
    YOOKASSA_SHOP_ID: shop,
    YOOKASSA_SECRET_KEY: `${mode}_SYNTHETIC-NOT-A-REAL-KEY`,
    YOOKASSA_RECEIPT_MODE: mode === "live" ? "npd_manual" : "disabled",
    YOOKASSA_FISCAL_PROFILE: "citygo_service_full_payment_v1",
    WEB_ORIGIN: origin,
  });
}
async function fixture(mode: "live" | "test" = "live", fiscal = true) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const state = {
    posts: 0,
    gets: 0,
    succeeded: false,
    createSucceeded: false,
    refundCreates: 0,
    refundGets: 0,
    refundPatch: {} as Partial<PaymentRefundObservation>,
    patch: {} as Record<string, unknown>,
  };
  const records = new Map<
    string,
    {
      id: string;
      body: {
        amount: { value: string; currency: string };
        metadata: { citygo_order_id: string };
      };
    }
  >();
  const client = new YooKassaClient({
    mode,
    shopId: shop,
    secretKey: `${mode}_SYNTHETIC-NOT-A-REAL-KEY`,
    fetch: async (url, init) => {
      assert.match(
        String(url),
        /^https:\/\/api\.yookassa\.ru\/v3\/payments(?:\/[^/]+)?$/,
      );
      let saved: typeof records extends Map<string, infer T> ? T : never;
      if (init?.method === "POST") {
        state.posts++;
        const body = JSON.parse(String(init.body));
        assert.equal(
          new Headers(init.headers).get("Idempotence-Key"),
          body.metadata.citygo_order_id,
        );
        const stored = (
          await db.query<{ create_payload: unknown }>(
            "select create_payload from payment_topup_orders where id=$1",
            [body.metadata.citygo_order_id],
          )
        ).rows[0];
        assert.ok(stored, "durable order precedes dispatch");
        assert.deepEqual(stored.create_payload, body);
        saved = records.get(body.metadata.citygo_order_id) ?? {
          id: randomUUID(),
          body,
        };
        records.set(body.metadata.citygo_order_id, saved);
      } else {
        state.gets++;
        const id = String(url).split("/").at(-1);
        const found = [...records.values()].find((record) => record.id === id);
        assert.ok(found);
        saved = found;
      }
      const succeeded =
        init?.method === "POST" ? state.createSucceeded : state.succeeded;
      return new Response(
        JSON.stringify({
          id: saved.id,
          status: succeeded ? "succeeded" : "pending",
          paid: succeeded,
          test: mode === "test",
          recipient: { account_id: shop },
          amount: saved.body.amount,
          metadata: saved.body.metadata,
          confirmation: {
            type: "redirect",
            confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${saved.id}`,
          },
          ...state.patch,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const config = {
    ...settings(mode),
    ...(fiscal ? {} : { YOOKASSA_FISCAL_PROFILE: "disabled" as const }),
  };
  const refundIds = new Map<string, string>();
  const refundInputs: PaymentRefundDispatchInput[] = [];
  function refundProof(
    payload: PaymentRefundDispatchInput,
    observation: PaymentRefundObservation["observation"],
  ): PaymentRefundObservation {
    const id = refundIds.get(payload.refundRequestId) ?? randomUUID();
    refundIds.set(payload.refundRequestId, id);
    return {
      id,
      refundRequestId: payload.refundRequestId,
      paymentId: payload.paymentId,
      orderId: payload.orderId,
      merchantId: shop,
      test: mode === "test",
      amountKopeks: payload.amountKopeks,
      currency: "RUB",
      refundedAmountKopeks: payload.refundedBeforeKopeks + payload.amountKopeks,
      status: "succeeded",
      observation,
      verifiedAt: new Date().toISOString(),
      ...state.refundPatch,
    };
  }
  const app = await buildApp({
    db,
    config,
    testing: true,
    paymentClient: client,
    refundClient: {
      createRefund: async (payload) => {
        state.refundCreates++;
        refundInputs.push(structuredClone(payload));
        return refundProof(payload, "create_response");
      },
      getRefund: async (id, payload) => {
        state.refundGets++;
        const proof = refundProof(payload, "server_get");
        assert.equal(id, proof.id);
        return proof;
      },
    },
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
      ...(body === undefined ? {} : { payload: body }),
    });
  async function register() {
    const reply = await call("POST", "/v1/auth/register", "", {
      consents: syntheticServiceConsents,
      email: randomUUID() + "@example.test",
      password: "abcdef",
    });
    assert.equal(reply.statusCode, 200, reply.body);
    return { token: reply.cookies[0]!.value, id: String(reply.json().user.id) };
  }
  const user = await register();
  const other = await register();
  // These legacy checkout/settlement scenarios explicitly establish their
  // synthetic live admission. Default-closed behavior has separate tests.
  if (mode === "live") {
    const operator = await register();
    await db.query("update users set role='super_admin' where id=$1", [
      operator.id,
    ]);
    const admission = new PaymentAdmission(
      db,
      createPaymentAdmissionBinding(config)!,
    );
    const actor = {
      userId: operator.id,
      sessionTokenHash: tokenHash(operator.token),
    };
    await admission.command(actor, {
      requestId: randomUUID(),
      expectedRevision: 1,
      action: "set_reconciliation",
      enabled: true,
    });
    const run = await admission.beginReconciliation();
    assert.ok(run);
    await admission.completeReconciliation({ ...run, success: true });
    await admission.command(actor, {
      requestId: randomUUID(),
      expectedRevision: 2,
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: true,
    });
  }
  const create = (requestId = randomUUID()) =>
    call("POST", "/v1/payments/topups", user.token, {
      requestId,
      amountKopeks: 10_000,
      receiptEmail: "receipt-buyer@synthetic-citygo-mail.ru",
    });
  const reconcile = (id: string, token = user.token, body: object = {}) =>
    call("POST", `/v1/payments/topups/${id}/reconcile`, token, body);
  const balance = async () =>
    (await call("GET", "/v1/ai/credit", user.token)).json<AiCredit>();
  return {
    db,
    app,
    config,
    client,
    state,
    records,
    refundInputs,
    user,
    other,
    call,
    create,
    reconcile,
    balance,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test("live fiscal request is immutable, owner-scoped and does not expose receipt contact", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const requestId = randomUUID();
  const reply = await f.create(requestId);
  assert.equal(reply.statusCode, 200, reply.body);
  const created = topupOrderSchema.parse(reply.json());
  const stored = (
    await f.db.query<{
      create_payload: { receipt: unknown };
      receipt_email: string;
      payload_version: number;
    }>(
      "select create_payload,receipt_email,payload_version from payment_topup_orders where id=$1",
      [created.orderId],
    )
  ).rows[0]!;
  assert.equal(stored.payload_version, 2);
  assert.equal(stored.receipt_email, "receipt-buyer@synthetic-citygo-mail.ru");
  const receipt = stored.create_payload.receipt as {
    customer: { email: string };
    items: {
      vat_code: number;
      payment_subject: string;
      payment_mode: string;
      amount: { value: string };
    }[];
  };
  assert.equal(receipt.customer.email, stored.receipt_email);
  assert.equal(receipt.items[0]!.vat_code, 1);
  assert.equal(receipt.items[0]!.payment_subject, "service");
  assert.equal(receipt.items[0]!.payment_mode, "full_payment");
  assert.equal(receipt.items[0]!.amount.value, "100.00");
  assert.doesNotMatch(JSON.stringify(receipt), /tax_system_code/);
  assert.doesNotMatch(reply.body, /receipt|synthetic-citygo-mail/);
  const path = `/v1/payments/topup-attempts/${requestId}`;
  const own = await f.call("GET", path, f.user.token);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().orderId, created.orderId);
  assert.doesNotMatch(own.body, /receipt|synthetic-citygo-mail/);
  assert.equal((await f.call("GET", path, f.other.token)).statusCode, 404);
  assert.equal((await f.call("GET", path)).statusCode, 401);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
  const changed = await f.call("POST", "/v1/payments/topups", f.user.token, {
    requestId,
    amountKopeks: 10_000,
    receiptEmail: "other-buyer@synthetic-citygo-mail.ru",
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.doesNotMatch(changed.body, /receipt-buyer|other-buyer/);
  assert.equal(f.state.posts, 1);
  assert.deepEqual(
    (
      await f.db.query<{ create_payload: unknown }>(
        "select create_payload from payment_topup_orders where id=$1",
        [created.orderId],
      )
    ).rows[0]!.create_payload,
    stored.create_payload,
  );
});

test("fiscal checkout rejects absent or fake email and caller-supplied receipt fields before persisting or POST", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const extra of [
    {},
    { receiptEmail: "admin@citygo.invalid" },
    { receiptEmail: "private-invalid-email" },
    {
      receiptEmail: "buyer@synthetic-citygo-mail.ru",
      receipt: { tax_system_code: 2 },
    },
  ]) {
    const reply = await f.call("POST", "/v1/payments/topups", f.user.token, {
      requestId: randomUUID(),
      amountKopeks: 10_000,
      ...extra,
    });
    assert.equal(reply.statusCode, 400, reply.body);
    assert.doesNotMatch(reply.body, /admin@|private-invalid|tax_system_code/);
  }
  assert.equal(f.state.posts, 0);
  assert.equal(
    (await f.db.query("select 1 from payment_topup_orders")).rows.length,
    0,
  );
});

test("legacy live runtime remains readable but cannot create new receipt-free payments", async (t) => {
  const f = await fixture("live", false);
  t.after(f.close);
  assert.equal((await f.balance()).topUpAvailable, false);
  const orders = new PaymentTopupOrders(
    f.db,
    createPaymentAdmissionBinding(f.config),
  );
  const requestId = randomUUID();
  const legacy = await orders.create(
    f.user.id,
    requestId,
    10_000,
    shop,
    false,
    origin + "/",
  );
  const read = await f.call(
    "GET",
    `/v1/payments/topup-attempts/${requestId}`,
    f.user.token,
  );
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().orderId, legacy.id);
  assert.equal((await f.create()).statusCode, 503);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
});

test("fiscal runtime never rewrites or re-POSTs an old receipt-free request", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const requestId = randomUUID();
  const orders = new PaymentTopupOrders(
    f.db,
    createPaymentAdmissionBinding(f.config),
  );
  const legacy = await orders.create(
    f.user.id,
    requestId,
    10_000,
    shop,
    false,
    origin + "/",
  );
  const reply = await f.create(requestId);
  assert.equal(reply.statusCode, 409, reply.body);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.deepEqual(
    (await orders.get(f.user.id, legacy.id)).createPayload,
    legacy.createPayload,
  );
  assert.equal(
    (
      await f.call(
        "GET",
        `/v1/payments/topup-attempts/${requestId}`,
        f.user.token,
      )
    ).statusCode,
    200,
  );
});

test("live checkout: 100 RUB credits exactly 100 CityGo once, with one paid refundable source and pending NPD duty", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const request = randomUUID();
  const reply = await f.create(request);
  assert.equal(reply.statusCode, 200, reply.body);
  const created = topupOrderSchema.parse(reply.json());
  assert.equal(created.test, false);
  assert.equal(created.creditMicros, 100_000_000);
  assert.equal(created.credited, false);
  assert.equal((await f.balance()).availableMicros, 0);
  assert.equal((await f.balance()).topUpAvailable, true);
  f.state.succeeded = true;
  for (const response of await Promise.all(
    Array.from({ length: 5 }, () => f.reconcile(created.orderId)),
  )) {
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(topupOrderSchema.parse(response.json()).credited, true);
  }
  const replay = await f.create(request);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(topupOrderSchema.parse(replay.json()).orderId, created.orderId);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.balance()).availableMicros, 100_000_000);
  for (const table of [
    "ai_credit_topups",
    "credit_source_lots",
    "npd_receipt_tasks",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 1);
  assert.deepEqual(
    (
      await f.db.query(
        "select amount_kopeks::text as amount,registration_status,delivery_status,correction_status from npd_receipt_tasks",
      )
    ).rows,
    [
      {
        amount: "10000",
        registration_status: "pending",
        delivery_status: "pending",
        correction_status: "not_required",
      },
    ],
  );
  const sourceReply = await f.call("GET", "/v1/payments/sources", f.user.token);
  assert.equal(sourceReply.statusCode, 200, sourceReply.body);
  const sources = ownerPaymentSourceListSchema.parse(sourceReply.json());
  assert.equal(sources.sources.length, 1);
  assert.equal(sources.sources[0]!.test, false);
  assert.equal(sources.sources[0]!.availableMicros, 100_000_000);
  assert.equal(sources.sources[0]!.sourceOperationId, created.orderId);
  assert.doesNotMatch(
    sourceReply.body,
    /merchantId|providerPaymentId|SYNTHETIC/,
  );
});

test("live create alone never credits; canceled fiscal registration cannot cancel a verified paid payment", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.state.createSucceeded = true;
  const created = topupOrderSchema.parse((await f.create()).json());
  assert.equal(created.status, "pending");
  assert.equal(created.credited, false);
  assert.equal((await f.balance()).availableMicros, 0);
  assert.equal(
    (await f.db.query("select 1 from npd_receipt_tasks")).rows.length,
    0,
  );
  f.state.succeeded = true;
  f.state.patch = { receipt_registration: "canceled" };
  assert.equal((await f.reconcile(created.orderId)).statusCode, 200);
  assert.equal((await f.balance()).availableMicros, 100_000_000);
});

test("live paid lot supports authorized partial refund, GET-only settlement and pending NPD correction exactly once", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = topupOrderSchema.parse((await f.create()).json());
  f.state.succeeded = true;
  assert.equal((await f.reconcile(created.orderId)).statusCode, 200);
  await f.db.query("update users set role='super_admin' where id=$1", [
    f.other.id,
  ]);
  const base = "/v1/admin/payments/refunds";
  const command = {
    requestId: randomUUID(),
    paymentOperationId: created.orderId,
    amountKopeks: 2500,
  };
  assert.equal(
    (await f.call("POST", base, f.user.token, command)).statusCode,
    403,
  );
  const reserved = await f.call("POST", base, f.other.token, command);
  assert.equal(reserved.statusCode, 200, reserved.body);
  const refund = reserved.json().refund;
  assert.equal(refund.test, false);
  assert.equal(refund.status, "reserved");
  assert.equal((await f.balance()).availableMicros, 75_000_000);
  assert.equal((await f.balance()).heldMicros, 25_000_000);
  const submitted = await f.call(
    "POST",
    `${base}/${refund.id}/submit`,
    f.other.token,
    {},
  );
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().refund.status, "pending");
  assert.equal((await f.balance()).heldMicros, 25_000_000);
  for (let attempt = 0; attempt < 2; attempt++) {
    const settled = await f.call(
      "POST",
      `${base}/${refund.id}/reconcile`,
      f.other.token,
      {},
    );
    assert.equal(settled.statusCode, 200, settled.body);
    assert.equal(settled.json().refund.status, "succeeded");
  }
  assert.equal(f.state.refundCreates, 1);
  assert.equal(
    f.refundInputs[0]!.receipt!.customer.email,
    "receipt-buyer@synthetic-citygo-mail.ru",
  );
  assert.equal(f.refundInputs[0]!.receipt!.items[0]!.amount.value, "25.00");
  assert.equal(f.state.refundGets, 2);
  const balance = await f.balance();
  assert.equal(balance.availableMicros, 75_000_000);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.grantedMicros, 75_000_000);
  assert.deepEqual(
    (
      await f.db.query(
        `select cumulative_refunded_kopeks::text as refunded,registration_status,delivery_status,correction_status
     from npd_receipt_tasks where id=$1`,
        [created.orderId],
      )
    ).rows,
    [
      {
        refunded: "2500",
        registration_status: "pending",
        delivery_status: "pending",
        correction_status: "required",
      },
    ],
  );
  assert.equal(
    (await f.db.query("select 1 from npd_refund_observations")).rows.length,
    1,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select refunded_micros::text as refunded,refund_reserved_micros::text as reserved from credit_source_lots where paid_operation_id=$1",
        [created.orderId],
      )
    ).rows,
    [{ refunded: "25000000", reserved: "0" }],
  );
});

test("full live refund omits receipt and keeps the original paid contact snapshot", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = topupOrderSchema.parse((await f.create()).json());
  f.state.succeeded = true;
  assert.equal((await f.reconcile(created.orderId)).statusCode, 200);
  await f.db.query("update users set role='super_admin' where id=$1", [
    f.other.id,
  ]);
  const base = "/v1/admin/payments/refunds";
  const reserved = await f.call("POST", base, f.other.token, {
    requestId: randomUUID(),
    paymentOperationId: created.orderId,
    amountKopeks: 10_000,
  });
  assert.equal(reserved.statusCode, 200, reserved.body);
  const submitted = await f.call(
    "POST",
    `${base}/${reserved.json().refund.id}/submit`,
    f.other.token,
    {},
  );
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(f.refundInputs.length, 1);
  assert.equal(f.refundInputs[0]!.receipt, undefined);
  assert.equal(
    Object.hasOwn(f.refundInputs[0]!.createPayload as object, "receipt"),
    false,
  );
  const settled = await f.call(
    "POST",
    `${base}/${reserved.json().refund.id}/reconcile`,
    f.other.token,
    {},
  );
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal((await f.balance()).availableMicros, 0);
  const task = (
    await f.db.query<{ buyer_email: string }>(
      "select buyer_email from npd_receipt_tasks where id=$1",
      [created.orderId],
    )
  ).rows[0]!;
  assert.equal(task.buyer_email, "receipt-buyer@synthetic-citygo-mail.ru");
});

test("live reconciliation rejects sandbox/shop/order/amount drift without any credit or receipt", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = topupOrderSchema.parse((await f.create()).json());
  f.state.succeeded = true;
  for (const patch of [
    { test: true },
    { recipient: { account_id: "654321" } },
    { metadata: { citygo_order_id: randomUUID() } },
    { amount: { value: "100.01", currency: "RUB" } },
    { paid: false },
    { refunded_amount: { value: "1.00", currency: "RUB" } },
  ]) {
    f.state.patch = patch;
    const response = await f.reconcile(created.orderId);
    assert.equal(response.statusCode, 503, response.body);
    assert.doesNotMatch(response.body, /SYNTHETIC|654321/);
    assert.equal((await f.balance()).availableMicros, 0);
  }
  for (const table of [
    "ai_credit_topups",
    "credit_source_lots",
    "npd_receipt_tasks",
  ])
    assert.equal((await f.db.query(`select 1 from ${table}`)).rows.length, 0);
});

test("live checkout retains authorization, password-change, CSRF and ownership boundaries before provider calls", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const body = { requestId: randomUUID(), amountKopeks: 10_000 };
  assert.equal(
    (await f.call("POST", "/v1/payments/topups", "", body)).statusCode,
    401,
  );
  assert.equal(
    (
      await f.call(
        "POST",
        "/v1/payments/topups",
        f.user.token,
        body,
        "https://foreign.example.test",
      )
    ).statusCode,
    403,
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.user.id,
  ]);
  assert.equal((await f.create()).statusCode, 403);
  await f.db.query("update users set must_change_password=false where id=$1", [
    f.user.id,
  ]);
  assert.equal(
    (
      await f.call("POST", "/v1/payments/topups", f.user.token, {
        ...body,
        test: true,
      })
    ).statusCode,
    400,
  );
  const created = topupOrderSchema.parse((await f.create()).json());
  assert.equal(
    (await f.reconcile(created.orderId, f.other.token)).statusCode,
    404,
  );
  assert.equal(
    (
      await f.call(
        "GET",
        `/v1/payments/topups/${created.orderId}`,
        f.other.token,
      )
    ).statusCode,
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

test("sandbox database cannot be reopened as live checkout, even with a different key and app instance", async (t) => {
  const f = await fixture("test");
  t.after(f.close);
  assert.equal((await f.create()).statusCode, 200);
  await assert.rejects(
    buildApp({
      db: f.db,
      config: settings(),
      testing: true,
      paymentClient: f.client,
    }),
    (error) => error instanceof DomainError && error.statusCode === 503,
  );
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.gets, 0);
});

test("live injected configuration cannot bypass manual-receipt, fixed-origin or isolated-test-client requirements", async () => {
  let touched = false;
  const touch = async () => {
    touched = true;
    throw new Error("Unexpected DB or provider call");
  };
  const db = {
    query: touch,
    exec: touch,
    transaction: touch,
    close: touch,
  } as unknown as Database;
  const paymentClient = { create: touch, get: touch };
  for (const patch of [
    { YOOKASSA_RECEIPT_MODE: "disabled" },
    { YOOKASSA_FISCAL_PROFILE: "unreviewed" },
    { YOOKASSA_SECRET_KEY: "test_SYNTHETIC-NOT-A-REAL-KEY" },
    { YOOKASSA_SHOP_ID: "not-a-shop" },
    { LLM_PROVIDER: "gigachat" },
    { AI_CREDIT_MODE: "disabled" },
    { WEB_ORIGIN: "https://pilot.example.test/another-path" },
    { NODE_ENV: "production" },
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
  assert.equal(touched, false);
});

test("machine notifications are durable hints; only an admin drain plus fresh GET can credit, never incoming status or amount", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const created = topupOrderSchema.parse((await f.create()).json());
  const saved = (
    await f.db.query<{ provider_payment_id: string }>(
      "select provider_payment_id from payment_topup_orders where id=$1",
      [created.orderId],
    )
  ).rows[0]!;
  const path = "/v1/payments/yookassa/notifications";
  const event = (name = "payment.succeeded") => ({
    type: "notification",
    event: name,
    object: {
      id: saved.provider_payment_id,
      status: "succeeded",
      paid: true,
      test: false,
      amount: { value: "999999.99", currency: "RUB" },
    },
  });
  const notify = (body: object) =>
    f.app.inject({ method: "POST", url: path, payload: body });
  assert.equal((await notify(event())).statusCode, 200);
  assert.equal((await f.balance()).availableMicros, 0);
  assert.equal(f.state.gets, 0);
  const drain = () =>
    f.call(
      "POST",
      "/v1/admin/payments/notifications/reconcile",
      f.other.token,
      { limit: 5 },
    );
  assert.equal((await drain()).statusCode, 403);
  await f.db.query("update users set role='admin' where id=$1", [f.other.id]);
  const pending = await drain();
  assert.equal(pending.statusCode, 200, pending.body);
  assert.deepEqual(pending.json(), { processed: 0, retained: 1 });
  assert.equal((await f.balance()).availableMicros, 0);
  // Even an incoming cancellation cannot cancel or credit: only the provider's
  // GET below establishes success. The prior pending hint remains retriable.
  f.state.succeeded = true;
  assert.equal((await notify(event("payment.canceled"))).statusCode, 200);
  const credited = await drain();
  assert.equal(credited.statusCode, 200, credited.body);
  assert.deepEqual(credited.json(), { processed: 1, retained: 0 });
  assert.equal((await f.balance()).availableMicros, 100_000_000);
  assert.equal((await notify(event("payment.canceled"))).statusCode, 200);
  assert.equal(
    (await f.db.query("select 1 from ai_credit_topups")).rows.length,
    1,
  );
  for (const headers of [
    { origin },
    { cookie: "citygo=" + f.user.token },
    { authorization: "Bearer fake" },
  ])
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: path,
          headers,
          payload: event(),
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: path + "?browser=1",
        payload: event(),
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/payments/topups",
        payload: { requestId: randomUUID(), amountKopeks: 100 },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: path,
        payload: { ...event(), padding: "x".repeat(17000) },
      })
    ).statusCode,
    413,
  );
});

test("live refund notification drains a saved refund through GET exactly once, retains POST hold, and creates one NPD correction", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const order = topupOrderSchema.parse((await f.create()).json());
  f.state.succeeded = true;
  assert.equal((await f.reconcile(order.orderId)).statusCode, 200);
  await f.db.query("update users set role='admin' where id=$1", [f.other.id]);
  const base = "/v1/admin/payments/refunds";
  const reserved = await f.call("POST", base, f.other.token, {
    requestId: randomUUID(),
    paymentOperationId: order.orderId,
    amountKopeks: 2500,
  });
  assert.equal(reserved.statusCode, 200, reserved.body);
  const refundId = String(reserved.json().refund.id);
  const submitted = await f.call(
    "POST",
    `${base}/${refundId}/submit`,
    f.other.token,
    {},
  );
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().refund.status, "pending");
  assert.equal((await f.balance()).heldMicros, 25_000_000);
  assert.equal(f.state.refundCreates, 1);
  assert.equal(f.state.refundGets, 0);
  const saved = (
    await f.db.query<{ provider_refund_id: string }>(
      "select provider_refund_id from payment_refunds where id=$1",
      [refundId],
    )
  ).rows[0]!;
  const notify = () =>
    f.app.inject({
      method: "POST",
      url: "/v1/payments/yookassa/notifications",
      payload: {
        type: "notification",
        event: "refund.succeeded",
        object: {
          id: saved.provider_refund_id,
          status: "succeeded",
          test: true,
          amount: { value: "999999.99", currency: "RUB" },
        },
      },
    });
  const drain = (token = f.other.token) =>
    f.call("POST", "/v1/admin/payments/notifications/reconcile", token, {
      limit: 5,
    });
  assert.equal((await notify()).statusCode, 200);
  assert.equal(f.state.refundGets, 0);
  assert.equal((await f.balance()).heldMicros, 25_000_000);
  assert.equal((await drain(f.user.token)).statusCode, 403);
  assert.equal(f.state.refundGets, 0);
  const settled = await drain();
  assert.equal(settled.statusCode, 200, settled.body);
  assert.deepEqual(settled.json(), { processed: 1, retained: 0 });
  assert.equal(f.state.refundGets, 1);
  const balance = await f.balance();
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.availableMicros, 75_000_000);
  assert.equal(balance.grantedMicros, 75_000_000);
  assert.equal(
    (
      await f.db.query("select status from payment_refunds where id=$1", [
        refundId,
      ])
    ).rows[0]!.status,
    "succeeded",
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select cumulative_refunded_kopeks::text as refunded,correction_status from npd_receipt_tasks where id=$1",
        [order.orderId],
      )
    ).rows,
    [{ refunded: "2500", correction_status: "required" }],
  );
  assert.equal((await notify()).statusCode, 200);
  const duplicate = await drain();
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.deepEqual(duplicate.json(), { processed: 0, retained: 0 });
  assert.equal(f.state.refundGets, 1);
  assert.equal(f.state.refundCreates, 1);
  assert.equal(
    (await f.db.query("select 1 from npd_refund_observations")).rows.length,
    1,
  );
  assert.equal(
    (
      await f.db.query(
        "select 1 from credit_refund_allocations where state='settled'",
      )
    ).rows.length,
    1,
  );
});

test("live refund notification with mismatched GET merchant or mode cannot settle the held refund", async (t) => {
  for (const patch of [{ merchantId: "999999" }, { test: true }]) {
    const f = await fixture();
    t.after(f.close);
    const order = topupOrderSchema.parse((await f.create()).json());
    f.state.succeeded = true;
    assert.equal((await f.reconcile(order.orderId)).statusCode, 200);
    await f.db.query("update users set role='admin' where id=$1", [f.other.id]);
    const base = "/v1/admin/payments/refunds";
    const reserved = await f.call("POST", base, f.other.token, {
      requestId: randomUUID(),
      paymentOperationId: order.orderId,
      amountKopeks: 2500,
    });
    assert.equal(reserved.statusCode, 200, reserved.body);
    const refundId = String(reserved.json().refund.id);
    const submitted = await f.call(
      "POST",
      `${base}/${refundId}/submit`,
      f.other.token,
      {},
    );
    assert.equal(submitted.statusCode, 200, submitted.body);
    const saved = (
      await f.db.query<{ provider_refund_id: string }>(
        "select provider_refund_id from payment_refunds where id=$1",
        [refundId],
      )
    ).rows[0]!;
    f.state.refundPatch = patch;
    const queued = await f.app.inject({
      method: "POST",
      url: "/v1/payments/yookassa/notifications",
      payload: {
        type: "notification",
        event: "refund.succeeded",
        object: { id: saved.provider_refund_id },
      },
    });
    assert.equal(queued.statusCode, 200, queued.body);
    const checked = await f.call(
      "POST",
      "/v1/admin/payments/notifications/reconcile",
      f.other.token,
      { limit: 1 },
    );
    assert.equal(checked.statusCode, 200, checked.body);
    assert.deepEqual(checked.json(), { processed: 0, retained: 1 });
    assert.equal(f.state.refundGets, 1);
    assert.equal((await f.balance()).heldMicros, 25_000_000);
    assert.equal((await f.balance()).grantedMicros, 100_000_000);
    assert.equal(
      (await f.db.query("select 1 from npd_refund_observations")).rows.length,
      0,
    );
    assert.deepEqual(
      (
        await f.db.query(
          "select status,review_reason from payment_refunds where id=$1",
          [refundId],
        )
      ).rows,
      [{ status: "review_required", review_reason: "provider_mismatch" }],
    );
  }
});

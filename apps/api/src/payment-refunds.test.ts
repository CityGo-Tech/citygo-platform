import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  AiCreditLedger,
  Repository,
  connectDatabase,
  migrate,
  type PaymentRefundDispatchInput,
  type PaymentRefundObservation,
} from "@citygo/db";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import { prepareRefunds as prepareTestRefunds } from "./payment-refunds.js";

const origin = "https://pilot.example.test",
  base = "/v1/admin/payments/refunds";
const settings = (enabled = true) =>
  readConfig({
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    WEB_ORIGIN: origin,
    ...(enabled
      ? {
          YOOKASSA_MODE: "test",
          YOOKASSA_SHOP_ID: "123456",
          YOOKASSA_SECRET_KEY: "test_SYNTHETIC-NOT-A-REAL-KEY",
        }
      : {}),
  });
async function fixture(t: TestContext, enabled = true) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const repo = new Repository(db),
    people = [];
  for (const role of ["super_admin", "user", "user"] as const) {
    const userId = await repo.register(
        `${randomUUID()}@example.test`,
        "unused-synthetic-hash",
      ),
      token = randomUUID();
    await db.query("update users set role=$2 where id=$1", [userId, role]);
    await repo.createSession(userId, tokenHash(token));
    people.push({ userId, token });
  }
  const [admin, buyer, other] = people as [
    { userId: string; token: string },
    { userId: string; token: string },
    { userId: string; token: string },
  ];
  const ledger = new AiCreditLedger(db),
    paymentOperationId = randomUUID(),
    providerPaymentId = randomUUID(),
    providerRefundId = randomUUID();
  const state = {
    creates: 0,
    gets: 0,
    failCreate: false,
    failGet: false,
    mismatch: false,
    status: "succeeded" as "pending" | "succeeded" | "canceled",
    revoked: false,
    payloads: [] as PaymentRefundDispatchInput[],
  };
  let requestId = "";
  const proof = (
    observation: "create_response" | "server_get",
    payload: PaymentRefundDispatchInput,
  ): PaymentRefundObservation & { test: true } => ({
    id: providerRefundId,
    refundRequestId: payload.refundRequestId,
    paymentId: providerPaymentId,
    orderId: paymentOperationId,
    merchantId: "123456",
    test: true,
    amountKopeks: state.mismatch
      ? payload.amountKopeks + 1
      : payload.amountKopeks,
    currency: "RUB",
    status: state.status,
    observation,
    refundedAmountKopeks:
      observation === "server_get" && state.status === "succeeded"
        ? payload.refundedBeforeKopeks + payload.amountKopeks
        : payload.refundedBeforeKopeks,
    verifiedAt: new Date().toISOString(),
  });
  const client = {
    createRefund: async (payload: PaymentRefundDispatchInput) => {
      state.creates++;
      state.payloads.push(payload);
      requestId = payload.refundRequestId;
      const rows = (
        await db.query<{ status: string }>(
          "select status from payment_refunds where id=$1",
          [requestId],
        )
      ).rows;
      assert.equal(
        rows[0]?.status,
        "unknown",
        "write-ahead reservation before POST",
      );
      assert.equal((await ledger.status(buyer.userId)).heldMicros, 25_000_000);
      if (state.revoked)
        await db.query("update users set role='user' where id=$1", [
          admin.userId,
        ]);
      if (state.failCreate)
        throw new Error("PRIVATE provider key/body must not leak");
      return proof("create_response", payload);
    },
    getRefund: async (id: string, payload: PaymentRefundDispatchInput) => {
      state.gets++;
      assert.equal(id, providerRefundId);
      assert.equal(
        payload.refundRequestId,
        requestId || payload.refundRequestId,
      );
      if (state.failGet) throw new Error("PRIVATE transport detail");
      return proof("server_get", payload);
    },
  };
  const app = await buildApp({
    db,
    config: settings(enabled),
    testing: true,
    ...(enabled ? { refundClient: client } : {}),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  await ledger.topUpConfirmed(buyer.userId, paymentOperationId, {
    providerPaymentId,
    paidKopeks: 10_000,
    merchantId: "123456",
    test: true,
    currency: "RUB",
    verification: "server_get_succeeded",
    verifiedAt: new Date().toISOString(),
  });
  const call = (
    method: "GET" | "POST",
    path: string,
    token = admin.token,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const command = {
    requestId: randomUUID(),
    paymentOperationId,
    amountKopeks: 2500,
  };
  const create = () => call("POST", base, admin.token, command);
  return {
    db,
    app,
    ledger,
    admin,
    buyer,
    other,
    state,
    call,
    create,
    command,
    providerRefundId,
    paymentOperationId,
  };
}

test("refund HTTP reserves then POST pins only; separate GET settles once; owner history is scoped", async (t) => {
  const f = await fixture(t),
    response = await f.create();
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().refund.id;
  assert.equal(f.state.creates, 0);
  assert.equal((await f.create()).json().refund.id, id);
  const submitted = await f.call(
    "POST",
    `${base}/${id}/submit`,
    f.admin.token,
    {},
  );
  assert.equal(submitted.statusCode, 200, submitted.body);
  assert.equal(submitted.json().refund.status, "pending");
  assert.equal((await f.ledger.status(f.buyer.userId)).heldMicros, 25_000_000);
  await f.call("POST", `${base}/${id}/submit`, f.admin.token, {});
  assert.equal(f.state.creates, 1);
  const reconciled = await f.call(
    "POST",
    `${base}/${id}/reconcile`,
    f.admin.token,
    {},
  );
  assert.equal(reconciled.statusCode, 200, reconciled.body);
  assert.equal(reconciled.json().refund.status, "succeeded");
  const replay = await f.call(
    "POST",
    `${base}/${id}/reconcile`,
    f.admin.token,
    {},
  );
  assert.equal(replay.statusCode, 200);
  assert.equal(
    (await f.ledger.status(f.buyer.userId)).availableMicros,
    75_000_000,
  );
  assert.equal(
    (await f.db.query("select * from npd_refund_observations")).rows.length,
    0,
  );
  const mine = await f.call("GET", "/v1/payments/refunds", f.buyer.token),
    other = await f.call("GET", "/v1/payments/refunds", f.other.token);
  assert.equal(mine.json().refunds.length, 1);
  assert.deepEqual(other.json().refunds, []);
  assert.ok(!mine.body.includes(f.providerRefundId));
  assert.ok(!mine.body.includes("merchantId"));
  const sources = await f.call("GET", "/v1/payments/sources", f.buyer.token);
  assert.equal(sources.statusCode, 200, sources.body);
  assert.equal(sources.json().sources[0].refundedMicros, 25_000_000);
  assert.equal(sources.json().truncated, false);
});

test("unknown create retains reserve and ID/payload; candidate is server checked, never accepted as proof", async (t) => {
  const f = await fixture(t),
    id = (await f.create()).json().refund.id;
  f.state.failCreate = true;
  const failed = await f.call(
    "POST",
    `${base}/${id}/submit`,
    f.admin.token,
    {},
  );
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().refund.status, "unknown");
  assert.ok(!failed.body.includes("PRIVATE"));
  assert.equal((await f.ledger.status(f.buyer.userId)).heldMicros, 25_000_000);
  const missing = await f.call(
    "POST",
    `${base}/${id}/reconcile`,
    f.admin.token,
    {},
  );
  assert.equal(missing.statusCode, 409);
  const candidate = await f.call(
    "POST",
    `${base}/${id}/reconcile`,
    f.admin.token,
    { candidateProviderRefundId: f.providerRefundId },
  );
  assert.equal(candidate.statusCode, 200, candidate.body);
  assert.equal(candidate.json().refund.status, "succeeded");
  assert.equal(f.state.gets, 1);
});

test("role/session and strict schemas protect every refund mutation and admin source read", async (t) => {
  const f = await fixture(t),
    id = (await f.create()).json().refund.id;
  for (const [method, path, payload] of [
    ["GET", base, undefined],
    ["GET", `${base}/${id}`, undefined],
    ["GET", `/v1/admin/payments/sources?userId=${f.buyer.userId}`, undefined],
    ["POST", base, f.command],
    ["POST", `${base}/${id}/submit`, {}],
    ["POST", `${base}/${id}/reconcile`, {}],
  ] as const) {
    assert.equal((await f.call(method, path, "", payload)).statusCode, 401);
    assert.equal(
      (await f.call(method, path, f.buyer.token, payload)).statusCode,
      403,
    );
  }
  for (const body of [
    { ...f.command, amountKopeks: 1.5 },
    { ...f.command, test: true },
    { ...f.command, amountKopeks: "2500" },
    { status: "succeeded" },
  ])
    assert.equal(
      (await f.call("POST", base, f.admin.token, body)).statusCode,
      400,
    );
  assert.equal(
    (
      await f.call("POST", `${base}/${id}/reconcile`, f.admin.token, {
        status: "succeeded",
      })
    ).statusCode,
    400,
  );
  assert.equal((await f.call("GET", `${base}?limit=0`)).statusCode, 400);
  assert.equal(
    (await f.call("GET", `${base}?limit=1&limit=2`)).statusCode,
    400,
  );
  assert.equal(f.state.creates, 0);
  assert.equal(f.state.gets, 0);
});

test("disabled payments keep read-only history but no refund monetary commands", async (t) => {
  const f = await fixture(t, false);
  assert.equal((await f.create()).statusCode, 503);
  assert.equal((await f.call("GET", base)).statusCode, 200);
  assert.equal(
    (await f.call("GET", "/v1/payments/sources", f.buyer.token)).statusCode,
    200,
  );
  assert.equal((await f.ledger.status(f.buyer.userId)).heldMicros, 0);
  assert.equal(
    (await f.db.query("select * from payment_refunds")).rows.length,
    0,
  );
});

test("revoked in-flight actor cannot receive PII, while provider ID is still durably recorded", async (t) => {
  const f = await fixture(t),
    id = (await f.create()).json().refund.id;
  f.state.revoked = true;
  const result = await f.call(
    "POST",
    `${base}/${id}/submit`,
    f.admin.token,
    {},
  );
  assert.equal(result.statusCode, 403, result.body);
  assert.ok(!result.body.includes(f.providerRefundId));
  const row = (
    await f.db.query<{ provider_refund_id: string; status: string }>(
      "select provider_refund_id,status from payment_refunds where id=$1",
      [id],
    )
  ).rows[0]!;
  assert.equal(row.provider_refund_id, f.providerRefundId);
  assert.equal(row.status, "pending");
  assert.equal((await f.ledger.status(f.buyer.userId)).heldMicros, 25_000_000);
});

test("refund runtime rejects injected clients outside isolated non-production sandbox", () => {
  const client = {
    createRefund: async () => {
      throw new Error("unused");
    },
    getRefund: async () => {
      throw new Error("unused");
    },
  };
  assert.throws(
    () => prepareTestRefunds(settings(false), { testing: true, client }),
    /isolated test harness/,
  );
  assert.throws(
    () => prepareTestRefunds(settings(), { client }),
    /isolated test harness/,
  );
  assert.throws(
    () =>
      prepareTestRefunds(
        { ...settings(), NODE_ENV: "production" },
        { testing: true, client },
      ),
    /isolated test harness/,
  );
});

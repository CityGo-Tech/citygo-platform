import test from "node:test";
import assert from "node:assert/strict";
import { createClient, createSessionGuard } from "./index.js";

const id = "a28e0d51-e390-4b82-899c-edc97156f93b";
const operationId = "764a1c6f-be17-4110-8a21-cb7d73783ccb";
const requestId = "02d382d5-1621-4f78-9470-5af45adddcab";
const stamp = "2026-10-18T12:00:00.000Z";
const refund = {
  id,
  requestId,
  userId: "1",
  paymentOperationId: operationId,
  providerPaymentId: operationId,
  merchantId: "synthetic-shop",
  test: true,
  amountKopeks: 100,
  providerRefundId: null,
  status: "reserved",
  revision: 1,
  attemptCount: 0,
  lastAttemptAt: null,
  reviewReason: null,
  createdAt: stamp,
  updatedAt: stamp,
};
const source = {
  sourceOperationId: operationId,
  userId: "1",
  providerPaymentId: id,
  merchantId: "synthetic-shop",
  test: true,
  grossMicros: 100_000_000,
  availableMicros: 100_000_000,
  spentMicros: 0,
  heldMicros: 0,
  refundReservedMicros: 0,
  refundedMicros: 0,
  createdAt: stamp,
};

test("refund creation reserves with the caller's exact intent and dispatch/reconcile are separate commands", async () => {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const client = createClient("/api", {
    fetch: async (url, init) => {
      calls.push({
        path: String(url),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      assert.equal(init?.credentials, "include");
      return Response.json(
        String(url).includes("?")
          ? { refunds: [refund], nextAfter: null }
          : { refund, events: [] },
      );
    },
  });
  const input = {
    requestId,
    paymentOperationId: operationId,
    amountKopeks: 100,
  };
  await client.createPaymentRefund(input);
  await client.adminPaymentRefunds({ status: "unknown", after: id, limit: 20 });
  await client.adminPaymentRefund(id);
  await client.submitPaymentRefund(id);
  await client.reconcilePaymentRefund(id);
  await client.reconcilePaymentRefund(id, {
    candidateProviderRefundId: operationId,
  });
  assert.deepEqual(calls, [
    { path: "/api/v1/admin/payments/refunds", method: "POST", body: input },
    {
      path: `/api/v1/admin/payments/refunds?limit=20&status=unknown&after=${id}`,
      method: "GET",
    },
    { path: `/api/v1/admin/payments/refunds/${id}`, method: "GET" },
    {
      path: `/api/v1/admin/payments/refunds/${id}/submit`,
      method: "POST",
      body: {},
    },
    {
      path: `/api/v1/admin/payments/refunds/${id}/reconcile`,
      method: "POST",
      body: {},
    },
    {
      path: `/api/v1/admin/payments/refunds/${id}/reconcile`,
      method: "POST",
      body: { candidateProviderRefundId: operationId },
    },
  ]);
});

test("refund client rejects malformed commands/selectors before network without echoing private input", async () => {
  let calls = 0;
  const client = createClient("/api", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.throws(
    () =>
      client.createPaymentRefund({
        requestId,
        paymentOperationId: operationId,
        amountKopeks: 99,
      }),
    /Некорректные/,
  );
  assert.throws(
    () =>
      client.reconcilePaymentRefund(id, {
        candidateProviderRefundId: "private@example.test",
      }),
    (error: Error) => !error.message.includes("private"),
  );
  assert.throws(
    () => client.adminPaymentRefunds({ limit: 101 }),
    /Некорректные/,
  );
  assert.throws(
    () => client.adminPaymentRefund("private@example.test"),
    (error: Error) => !error.message.includes("private"),
  );
  await assert.rejects(client.adminPaymentSources("01"), /Некорректные/);
  assert.equal(calls, 0);
});

test("refund client binds returned IDs, original payment and amount to the requested operation", async () => {
  const input = {
    requestId,
    paymentOperationId: operationId,
    amountKopeks: 100,
  };
  for (const patch of [
    { requestId: id },
    { paymentOperationId: id },
    { amountKopeks: 200 },
  ]) {
    const client = createClient("/api", {
      fetch: async () =>
        Response.json({ refund: { ...refund, ...patch }, events: [] }),
    });
    await assert.rejects(client.createPaymentRefund(input), /не соответствует/);
  }
  const client = createClient("/api", {
    fetch: async () =>
      Response.json({ refund: { ...refund, id: operationId }, events: [] }),
  });
  for (const call of [
    () => client.adminPaymentRefund(id),
    () => client.submitPaymentRefund(id),
    () => client.reconcilePaymentRefund(id),
  ])
    await assert.rejects(call(), /не соответствует/);
});

test("unknown/refused dispatch does not trigger another POST or invent success", async () => {
  for (const status of [403, 409, 503]) {
    let calls = 0;
    const client = createClient("/api", {
      fetch: async () => {
        calls++;
        return Response.json({ error: "Проверьте журнал" }, { status });
      },
    });
    await assert.rejects(
      client.submitPaymentRefund(id),
      (error: { status?: number }) => error.status === status,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = createClient("/api", {
    fetch: async () => {
      calls++;
      return Response.json({
        refund: {
          ...refund,
          status: "unknown",
          attemptCount: 1,
          lastAttemptAt: stamp,
          reviewReason: "dispatch_result_unknown",
        },
        events: [],
      });
    },
  });
  assert.equal((await client.submitPaymentRefund(id)).refund.status, "unknown");
  assert.equal(calls, 1);
});

test("source selection is owner bound and owner responses cannot contain provider/admin metadata", async () => {
  let path = "";
  const client = createClient("/api", {
    fetch: async (url) => {
      path = String(url);
      return Response.json({ sources: [source], truncated: false });
    },
  });
  await client.adminPaymentSources("1");
  assert.equal(path, "/api/v1/admin/payments/sources?userId=1");
  await assert.rejects(client.adminPaymentSources("2"), /не соответствует/);
  await assert.rejects(client.paymentSources(), /не соответствует/);
  const ownerRefund = {
    id,
    paymentOperationId: operationId,
    amountKopeks: 100,
    test: true,
    status: "reserved",
    revision: 1,
    createdAt: stamp,
    updatedAt: stamp,
  };
  const safe = createClient("/api", {
    fetch: async () => Response.json({ refunds: [ownerRefund] }),
  });
  assert.equal((await safe.paymentRefunds()).refunds[0]?.id, id);
  const unsafe = createClient("/api", {
    fetch: async () => Response.json({ refunds: [refund] }),
  });
  await assert.rejects(unsafe.paymentRefunds(), /не соответствует/);
});

test("late refund response cannot populate a replaced administrative session", async () => {
  const session = createSessionGuard();
  let resolve!: (response: Response) => void;
  let unauthorized = 0;
  const client = createClient("/api", {
    signal: () => session.capture().signal,
    onUnauthorized: () => {
      unauthorized++;
    },
    fetch: async () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  });
  const pending = client.adminPaymentRefund(id);
  const rejected = assert.rejects(pending, /прежней сессии/);
  session.reset();
  resolve(Response.json({ refund, events: [] }, { status: 401 }));
  await rejected;
  assert.equal(unauthorized, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "./index.js";
test("admin routing client sends the displayed revision and policy without auto-retry", async () => {
  const original = globalThis.fetch;
  const requests: { method: string; body: unknown }[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push({
      method: options?.method ?? "GET",
      body: options?.body ? JSON.parse(String(options.body)) : null,
    });
    return options?.method === "POST"
      ? Response.json({ error: "Настройка изменена" }, { status: 409 })
      : Response.json({
          current: { provider: "disabled", policyId: null, revision: 1 },
          effectiveProvider: "unconfigured",
          environmentDisabled: false,
          automaticFallback: false,
          options: [],
          audit: [],
        });
  };
  try {
    const client = createClient("http://test");
    await client.aiControl();
    const input = {
      provider: "disabled" as const,
      policyId: null,
      expectedRevision: 1,
    };
    await assert.rejects(client.setAiRouting(input), /Настройка изменена/);
    assert.deepEqual(requests, [
      { method: "GET", body: null },
      { method: "POST", body: input },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("client sends explicit consent actions and the viewed policy ID with chat", async () => {
  const original = globalThis.fetch;
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({
      path: String(url),
      body: JSON.parse(String(options?.body)),
    });
    return String(url).endsWith("/messages")
      ? new Response('data: {"type":"done","messageId":"1"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        })
      : Response.json({ ok: true });
  };
  try {
    const client = createClient("http://test");
    const policyId = "a".repeat(64);
    await client.aiConsent({ action: "granted", policyId });
    await client.stream("1", "test", "uuid", () => {}, undefined, policyId);
    await client.aiConsent({ action: "revoked" });
    assert.deepEqual(requests, [
      {
        path: "http://test/v1/ai/consent",
        body: { action: "granted", policyId },
      },
      {
        path: "http://test/v1/threads/1/messages",
        body: { text: "test", requestId: "uuid", policyId },
      },
      { path: "http://test/v1/ai/consent", body: { action: "revoked" } },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("SSE decoder preserves split UTF-8, multiple events and terminal state", async () => {
  const original = globalThis.fetch;
  const bytes = new TextEncoder().encode(
    'data: {"type":"delta","text":"Жильё"}\n\ndata: {"type":"done","messageId":"1"}\n\n',
  );
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  try {
    const events: unknown[] = [];
    await createClient("http://test").stream("1", "test", "uuid", (event) =>
      events.push(event),
    );
    assert.deepEqual(events, [
      { type: "delta", text: "Жильё" },
      { type: "done", messageId: "1" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("SSE connection closing without done is a visible error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('data: {"type":"delta","text":"partial"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  try {
    await assert.rejects(
      createClient("http://test").stream("1", "test", "uuid", () => {}),
      /Соединение прервано/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

const paymentOrder = {
  orderId: "4a7ecb31-0895-4b81-965b-69f47c6ce9e7",
  amountKopeks: 10000,
  creditMicros: 100000000,
  currency: "RUB",
  test: true,
  status: "pending",
  credited: false,
  confirmationUrl: "https://checkout.example.test/pay",
  createdAt: "2026-10-18T10:00:00.000Z",
  updatedAt: "2026-10-18T10:00:00.000Z",
} as const;

test("test checkout client retains caller's idempotency key and requires explicit reconciliation", async () => {
  const requests: {
    url: string;
    method: string;
    body: unknown;
    credentials: unknown;
    token: unknown;
  }[] = [];
  const client = createClient("/api", {
    token: () => "synthetic-session",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        credentials: init?.credentials,
        token: (init?.headers as Record<string, string>).Authorization,
      });
      return Response.json(paymentOrder);
    },
  });
  const input = {
    requestId: "356c6b57-eb44-43c6-af7c-7e392a315aeb",
    amountKopeks: 10000,
  };
  await client.createTopup(input);
  await client.createTopup(input);
  await client.topupOrder(paymentOrder.orderId);
  await client.reconcileTopup(paymentOrder.orderId);
  assert.deepEqual(
    requests.map(({ url, method, body }) => ({ url, method, body })),
    [
      { url: "/api/v1/payments/topups", method: "POST", body: input },
      { url: "/api/v1/payments/topups", method: "POST", body: input },
      {
        url: `/api/v1/payments/topups/${paymentOrder.orderId}`,
        method: "GET",
        body: undefined,
      },
      {
        url: `/api/v1/payments/topups/${paymentOrder.orderId}/reconcile`,
        method: "POST",
        body: {},
      },
    ],
  );
  assert.ok(
    requests.every(
      (request) =>
        request.credentials === "include" &&
        request.token === "Bearer synthetic-session",
    ),
  );
});

test("checkout client preserves the explicit server mode without activating checkout or initiating payment", async () => {
  for (const testMode of [true, false]) {
    const requests: { path: string; method: string; body: unknown }[] = [];
    const client = createClient("/api", {
      fetch: async (url, init) => {
        requests.push({
          path: String(url),
          method: init?.method ?? "GET",
          body: init?.body,
        });
        return Response.json({ ...paymentOrder, test: testMode });
      },
    });
    const order = await client.topupOrder(paymentOrder.orderId);
    assert.equal(order.test, testMode);
    assert.equal(order.credited, false);
    assert.equal(order.status, "pending");
    // Reading a server-selected mode never creates a payment, changes mode or
    // performs reconciliation automatically. Neither client input nor a DTO is
    // a runtime/merchant authorization to activate real financial operations.
    assert.deepEqual(requests, [
      {
        path: `/api/v1/payments/topups/${paymentOrder.orderId}`,
        method: "GET",
        body: undefined,
      },
    ]);
    assert.throws(() =>
      client.createTopup({
        requestId: paymentOrder.orderId,
        amountKopeks: 10000,
        test: testMode,
      } as Parameters<typeof client.createTopup>[0]),
    );
    assert.equal(requests.length, 1);
  }
});

test("checkout client rejects unsafe payment links, invalid sums and malformed mode flags", async () => {
  for (const patch of [
    { confirmationUrl: "http://checkout.example.test" },
    { creditMicros: 1000000000 },
    { test: "false" },
    { test: null },
    { test: undefined },
    { test: 0 },
    { credited: true },
  ]) {
    const client = createClient("/api", {
      fetch: async () => Response.json({ ...paymentOrder, ...patch }),
    });
    await assert.rejects(
      client.topupOrder(paymentOrder.orderId),
      /не соответствует/,
    );
  }
  let calls = 0;
  const client = createClient("/api", {
    fetch: async () => {
      calls++;
      return Response.json(paymentOrder);
    },
  });
  assert.throws(() =>
    client.createTopup({ requestId: paymentOrder.orderId, amountKopeks: 99 }),
  );
  assert.equal(calls, 0);
});

test("test checkout client rejects another order or another amount returned by the server", async () => {
  const client = createClient("/api", {
    fetch: async () => Response.json(paymentOrder),
  });
  const otherId = "356c6b57-eb44-43c6-af7c-7e392a315aeb";
  await assert.rejects(client.topupOrder(otherId), /запрошенному платежу/);
  await assert.rejects(client.reconcileTopup(otherId), /запрошенному платежу/);
  await assert.rejects(
    client.createTopup({ requestId: otherId, amountKopeks: 100 }),
    /запрошенному платежу/,
  );
});

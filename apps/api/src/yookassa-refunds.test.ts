import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildYooKassaReceipt, type YooKassaReceipt } from "@citygo/contracts";
import {
  YooKassaRefundClient,
  YooKassaRefundError,
  YooKassaTestRefundClient,
  YooKassaTestRefundError,
  type YooKassaTestRefundInput,
} from "./yookassa-refunds.js";

const shopId = "123456";
const secretKey = "test_SYNTHETIC_NOT_REAL";
const paymentId = "2419a771-000f-5000-9000-1edaf29243f2";
const refundId = "2419a771-001f-5000-9000-1edaf29243f3";
const input = (): YooKassaTestRefundInput => ({
  refundRequestId: randomUUID(),
  paymentId,
  orderId: randomUUID(),
  paymentAmountKopeks: 10_001,
  amountKopeks: 101,
  refundedBeforeKopeks: 0,
  createdAt: new Date().toISOString(),
});
const payment = (i: YooKassaTestRefundInput, refunded = "0.00") => ({
  id: paymentId,
  status: "succeeded",
  paid: true,
  test: true,
  refundable: true,
  amount: { value: "100.01", currency: "RUB" },
  refunded_amount: { value: refunded, currency: "RUB" },
  recipient: { account_id: shopId },
  metadata: { citygo_order_id: i.orderId },
});
const refund = (i: YooKassaTestRefundInput, status = "pending") => ({
  id: refundId,
  payment_id: paymentId,
  amount: { value: "1.01", currency: "RUB" },
  status,
  metadata: { citygo_refund_id: i.refundRequestId },
  created_at: new Date().toISOString(),
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

test("partial refund snapshots explicit receipt and complete persisted body before payment GET", async () => {
  const i = input();
  const receipt = buildYooKassaReceipt({
    email: "buyer@citygo-mail.ru",
    amountKopeks: i.amountKopeks,
    test: true,
  });
  const saved = {
    payment_id: i.paymentId,
    amount: { value: "1.01", currency: "RUB" },
    description: "Тестовый возврат CityGo",
    metadata: { citygo_refund_id: i.refundRequestId },
    receipt,
  };
  let release!: () => void;
  const f = fixture([
    async () => {
      await new Promise<void>((ok) => {
        release = ok;
      });
      return json(payment(i));
    },
    () => json(refund(i)),
  ]);
  const pending = f.client.createRefund({
    ...i,
    receipt,
    createPayload: saved,
  });
  receipt.customer.email = "changed@citygo-mail.ru";
  receipt.items[0]!.amount.value = "9.99";
  saved.metadata.citygo_refund_id = randomUUID();
  release();
  await pending;
  const sent = JSON.parse(String(f.calls[1]!.init.body));
  assert.equal(sent.receipt.customer.email, "buyer@citygo-mail.ru");
  assert.equal(sent.receipt.items[0].amount.value, "1.01");
  assert.equal(sent.metadata.citygo_refund_id, i.refundRequestId);
  assert.equal(
    new Headers(f.calls[1]!.init.headers).get("Idempotence-Key"),
    i.refundRequestId,
  );
});
test("refund receipt total, strict profile and saved payload reject before payment GET or refund POST", async () => {
  const i = input();
  const receipt = buildYooKassaReceipt({
    email: "PRIVATE@citygo-mail.ru",
    amountKopeks: i.amountKopeks,
  });
  const f = fixture([]);
  for (const invalid of [
    { ...receipt, tax_system_code: 1 },
    { ...receipt, customer: { email: "admin@citygo.invalid" } },
    { ...receipt, items: [{ ...receipt.items[0], payment_mode: "advance" }] },
    {
      ...receipt,
      items: [
        { ...receipt.items[0], amount: { value: "1.00", currency: "RUB" } },
      ],
    },
  ])
    await rejected(
      f.client.createRefund({ ...i, receipt: invalid as YooKassaReceipt }),
      "invalid_input",
    );
  await rejected(
    f.client.createRefund({ ...i, receipt, createPayload: { receipt } }),
    "invalid_input",
  );
  assert.equal(f.calls.length, 0);
});
test("refund registration status is independent of monetary succeeded status", async () => {
  const i = input();
  for (const receipt_registration of [
    "pending",
    "succeeded",
    "canceled",
  ] as const) {
    const f = fixture([
      () => json({ ...refund(i, "succeeded"), receipt_registration }),
      () => json(payment(i, "1.01")),
    ]);
    const observed = await f.client.getRefund(refundId, i);
    assert.equal(observed.status, "succeeded");
    assert.equal(observed.receiptRegistration, receipt_registration);
  }
  const f = fixture([
    () => json({ ...refund(i), receipt_registration: "PRIVATE invalid" }),
    () => json(payment(i)),
  ]);
  await rejected(
    f.client.getRefund(refundId, i),
    "invalid_response",
    "observation_failed",
  );
});

test("persisted monetary POST body cannot drift across explicit retries or code versions", async () => {
  const i = input();
  const payload = {
    payment_id: i.paymentId,
    amount: { value: "1.01", currency: "RUB" },
    description: "Тестовый возврат CityGo",
    metadata: { citygo_refund_id: i.refundRequestId },
  };
  let posts = 0;
  const client = new YooKassaTestRefundClient({
    shopId,
    secretKey,
    fetch: async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        assert.deepEqual(JSON.parse(String(init.body)), payload);
        return json(refund(i));
      }
      return json(payment(i));
    },
  });
  await client.createRefund({ ...i, createPayload: payload });
  assert.equal(posts, 1);
  for (const changed of [
    { ...payload, description: "changed by future deployment" },
    { ...payload, amount: { value: "1.02", currency: "RUB" } },
    {},
  ])
    await assert.rejects(
      client.createRefund({ ...i, createPayload: changed }),
      (failure: unknown) =>
        failure instanceof YooKassaTestRefundError &&
        failure.outcome === "not_sent",
    );
  assert.equal(posts, 1);
});
function fixture(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[calls.length - 1];
    assert.ok(next, "No unplanned HTTP calls or implicit retries");
    return next();
  };
  return {
    calls,
    client: new YooKassaTestRefundClient({ shopId, secretKey, fetch }),
  };
}
async function rejected(
  work: Promise<unknown>,
  code: YooKassaTestRefundError["code"],
  outcome: YooKassaTestRefundError["outcome"] = "not_sent",
) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof YooKassaTestRefundError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.doesNotMatch(
      String(error) + JSON.stringify(error),
      /SYNTHETIC|123456|Basic|2419a771|PRIVATE|response body/i,
    );
    return true;
  });
}

test("refund transport accepts sandbox credentials only and does not serialize secrets", () => {
  for (const options of [
    { shopId, secretKey: "live_PRIVATE_KEY" },
    { shopId: "0", secretKey },
    { shopId: "not-digits", secretKey },
    { shopId, secretKey: "test_" },
    { shopId, secretKey: "test_PRIVATE:key" },
    { shopId, secretKey: "test_PRIVATE\nkey" },
  ])
    assert.throws(
      () => new YooKassaTestRefundClient(options),
      (error) =>
        error instanceof YooKassaTestRefundError &&
        error.code === "configuration" &&
        !String(error).includes("PRIVATE"),
    );
  assert.equal(JSON.stringify(fixture([]).client), "{}");
});

test("refund mode must be explicit and key prefix must match before HTTP", () => {
  assert.equal(YooKassaRefundError, YooKassaTestRefundError);
  for (const options of [
    { mode: "live", shopId, secretKey },
    { mode: "test", shopId, secretKey: "live_SYNTHETIC_NOT_REAL" },
    { mode: undefined, shopId, secretKey },
    { mode: "live", shopId, secretKey: "live_" },
    { mode: "live", shopId, secretKey: "live_PRIVATE:key" },
    { mode: "live", shopId, secretKey: "live_PRIVATE\nkey" },
    { mode: "live", shopId: "0", secretKey: "live_SYNTHETIC_NOT_REAL" },
  ])
    assert.throws(
      () =>
        new YooKassaRefundClient(
          options as ConstructorParameters<typeof YooKassaRefundClient>[0],
        ),
      (error: unknown) =>
        error instanceof YooKassaRefundError &&
        error.code === "configuration" &&
        error.outcome === "not_sent" &&
        !/SYNTHETIC|PRIVATE/.test(String(error) + JSON.stringify(error)),
    );
  assert.throws(
    () =>
      new YooKassaTestRefundClient({
        ...{ mode: "live" },
        shopId,
        secretKey: "live_SYNTHETIC_NOT_REAL",
      }),
    YooKassaRefundError,
  );
});

for (const mode of ["test", "live"] as const) {
  function modeFixture(responses: (() => Response | Promise<Response>)[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new YooKassaRefundClient({
      mode,
      shopId,
      secretKey: mode + "_SYNTHETIC_NOT_REAL",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = responses[calls.length - 1];
        assert.ok(next, "No unplanned requests or implicit retries");
        return next();
      },
    });
    return { client, calls };
  }
  const modePayment = (i: YooKassaTestRefundInput, refunded = "0.00") => ({
    ...payment(i, refunded),
    test: mode === "test",
  });

  test(`${mode} refund POST and settlement GET use the original merchant/mode, never invented refund fields`, async () => {
    const i = input();
    const payload = {
      payment_id: i.paymentId,
      amount: { value: "1.01", currency: "RUB" },
      description:
        mode === "test" ? "Тестовый возврат CityGo" : "Возврат средств CityGo",
      metadata: { citygo_refund_id: i.refundRequestId },
    };
    const f = modeFixture([
      () => json(modePayment(i)),
      () => json(refund(i, "succeeded")),
      () => json(refund(i, "succeeded")),
      () => json(modePayment(i, "1.01")),
    ]);
    const created = await f.client.createRefund({
      ...i,
      createPayload: payload,
    });
    assert.equal(created.test, mode === "test");
    assert.equal(created.observation, "create_response");
    assert.equal(created.refundedAmountKopeks, 0);
    assert.deepEqual(JSON.parse(String(f.calls[1]!.init.body)), payload);
    const observed = await f.client.getRefund(refundId, i);
    assert.equal(observed.test, mode === "test");
    assert.equal(observed.observation, "server_get");
    assert.equal(observed.refundedAmountKopeks, 101);
    assert.deepEqual(
      f.calls.map((call) => call.init.method),
      ["GET", "POST", "GET", "GET"],
    );
    assert.equal(
      new Headers(f.calls[1]!.init.headers).get("Idempotence-Key"),
      i.refundRequestId,
    );
    assert.equal(
      new Headers(f.calls[1]!.init.headers).get("Authorization"),
      "Basic " +
        Buffer.from(shopId + ":" + mode + "_SYNTHETIC_NOT_REAL").toString(
          "base64",
        ),
    );
    assert.equal(JSON.stringify(f.client), "{}");
  });

  test(`${mode} cross-mode or wrong-original payment cannot authorize a refund POST or settlement`, async () => {
    for (const patch of [
      { test: mode !== "test" },
      { test: undefined },
      { test: "false" },
      { recipient: { account_id: "999999" } },
      { metadata: { citygo_order_id: randomUUID() } },
      { amount: { value: "100.00", currency: "RUB" } },
    ]) {
      const i = input();
      const create = modeFixture([() => json({ ...modePayment(i), ...patch })]);
      await rejected(create.client.createRefund(i), "payment_mismatch");
      assert.equal(create.calls.length, 1);
      const read = modeFixture([
        () => json(refund(i, "succeeded")),
        () => json({ ...modePayment(i, "1.01"), ...patch }),
      ]);
      await rejected(
        read.client.getRefund(refundId, i),
        "payment_mismatch",
        "observation_failed",
      );
      assert.equal(read.calls.length, 2);
    }
  });

  test(`${mode} ambiguous POST remains unknown with no implicit retry and same immutable body on explicit replay`, async () => {
    const i = input();
    const f = modeFixture([
      () => json(modePayment(i)),
      () => new Response("PRIVATE response body", { status: 500 }),
      () => json(modePayment(i)),
      () => json(refund(i)),
    ]);
    await rejected(f.client.createRefund(i), "http", "unknown");
    assert.equal(f.calls.length, 2);
    await f.client.createRefund(i);
    assert.equal(f.calls.length, 4);
    assert.equal(f.calls[1]!.init.body, f.calls[3]!.init.body);
    assert.equal(
      new Headers(f.calls[1]!.init.headers).get("Idempotence-Key"),
      new Headers(f.calls[3]!.init.headers).get("Idempotence-Key"),
    );
  });

  test(`${mode} persisted refund description cannot cross modes or drift on retry`, async () => {
    const i = input();
    const f = modeFixture([]);
    await rejected(
      f.client.createRefund({
        ...i,
        createPayload: {
          payment_id: i.paymentId,
          amount: { value: "1.01", currency: "RUB" },
          description:
            mode === "test"
              ? "Возврат средств CityGo"
              : "Тестовый возврат CityGo",
          metadata: { citygo_refund_id: i.refundRequestId },
        },
      }),
      "invalid_input",
    );
    assert.equal(f.calls.length, 0);
  });

  test(`${mode} expired create window stops before HTTP and old refunds remain GET-only`, async () => {
    const i = { ...input(), createdAt: "2025-01-01T00:00:00.000Z" };
    const f = modeFixture([
      () => json(refund(i, "succeeded")),
      () => json(modePayment(i, "1.01")),
    ]);
    await rejected(f.client.createRefund(i), "invalid_input");
    assert.equal(f.calls.length, 0);
    assert.equal((await f.client.getRefund(refundId, i)).test, mode === "test");
    assert.equal(f.calls.length, 2);
  });

  test(`${mode} one refund deadline bounds stalled POST and preserves unknown outcome`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const i = input();
    const f = modeFixture([
      () => json(modePayment(i)),
      () => new Promise<Response>(() => {}),
    ]);
    const pending = rejected(f.client.createRefund(i), "timeout", "unknown");
    for (let n = 0; n < 20; n++) await Promise.resolve();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]!.init.signal, f.calls[1]!.init.signal);
    t.mock.timers.tick(10_001);
    await pending;
    assert.equal(f.calls[1]!.init.signal?.aborted, true);
  });
}

test("refund create authenticates original sandbox payment first and sends exact frozen identity", async () => {
  const i = input();
  const f = fixture([
    () => json(payment(i)),
    () => json({ ...refund(i, "succeeded"), private: "PRIVATE" }),
  ]);
  const observed = await f.client.createRefund(i);
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls[0]!.url,
    "https://api.yookassa.ru/v3/payments/" + paymentId,
  );
  const call = f.calls[1]!;
  assert.equal(call.url, "https://api.yookassa.ru/v3/refunds");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("Idempotence-Key"), i.refundRequestId);
  assert.equal(
    headers.get("Authorization"),
    "Basic " + Buffer.from(shopId + ":" + secretKey).toString("base64"),
  );
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    payment_id: paymentId,
    amount: { value: "1.01", currency: "RUB" },
    description: "Тестовый возврат CityGo",
    metadata: { citygo_refund_id: i.refundRequestId },
  });
  assert.equal(observed.status, "succeeded");
  assert.equal(observed.observation, "create_response");
  assert.equal(observed.refundedAmountKopeks, 0);
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE|SYNTHETIC|Basic/);
  assert.equal("credited" in observed, false);
});

test("separate refund GET verifies refund relation and original merchant/test without invented refund fields", async () => {
  const i = input();
  const raw = refund(i, "succeeded");
  assert.equal("test" in raw, false);
  assert.equal("recipient" in raw, false);
  const f = fixture([() => json(raw), () => json(payment(i, "1.01"))]);
  const result = await f.client.getRefund(refundId, i);
  assert.equal(result.test, true);
  assert.equal(result.merchantId, shopId);
  assert.equal(result.amountKopeks, 101);
  assert.equal(result.refundedAmountKopeks, 101);
  assert.equal(result.observation, "server_get");
  assert.deepEqual(
    f.calls.map((call) => call.init.method),
    ["GET", "GET"],
  );
  assert.equal(
    new Headers(f.calls[0]!.init.headers).has("Idempotence-Key"),
    false,
  );
});

test("invalid input, sub-ruble refund or remainder, and elapsed create window do not reach HTTP", async () => {
  const i = input();
  for (const patch of [
    { refundRequestId: "PRIVATE" },
    { paymentId: "https://PRIVATE.test" },
    { orderId: "../PRIVATE" },
    { amountKopeks: 99 },
    { amountKopeks: 100.5 },
    { amountKopeks: Number.NaN },
    { amountKopeks: 10_000 },
    { amountKopeks: 10_002 },
    { refundedBeforeKopeks: -1 },
    { paymentAmountKopeks: 100.01 },
    { createdAt: "PRIVATE" },
    { createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString() },
    { createdAt: new Date(Date.now() + 120_000).toISOString() },
  ]) {
    const f = fixture([]);
    await rejected(f.client.createRefund({ ...i, ...patch }), "invalid_input");
    assert.equal(f.calls.length, 0);
  }
  const f = fixture([]);
  await rejected(f.client.getRefund("PRIVATE", i), "invalid_input");
  assert.equal(f.calls.length, 0);
});

test("full remaining refund and exact one-ruble remainder are accepted", async () => {
  for (const [amountKopeks, value] of [
    [10_001, "100.01"],
    [9_901, "99.01"],
  ] as const) {
    const i = { ...input(), amountKopeks };
    const f = fixture([
      () => json(payment(i)),
      () => json({ ...refund(i), amount: { value, currency: "RUB" } }),
    ]);
    assert.equal((await f.client.createRefund(i)).amountKopeks, amountKopeks);
  }
});

test("unpaid, wrong original payment, merchant, mode, order, amount or refund total never sends a refund", async () => {
  const i = input();
  for (const patch of [
    { id: refundId },
    { status: "waiting_for_capture" },
    { paid: false },
    { test: false },
    { test: undefined },
    { refundable: false },
    { recipient: { account_id: "999999" } },
    { recipient: {} },
    { metadata: { citygo_order_id: randomUUID() } },
    { amount: { value: "100.00", currency: "RUB" } },
    { amount: { value: "100.01", currency: "USD" } },
    { amount: { value: "1.0001e2", currency: "RUB" } },
    { refunded_amount: undefined },
    { refunded_amount: { value: "1.00", currency: "RUB" } },
    { refunded_amount: { value: "101.00", currency: "RUB" } },
  ]) {
    const f = fixture([() => json({ ...payment(i), ...patch })]);
    await rejected(f.client.createRefund(i), "payment_mismatch");
    assert.equal(f.calls.length, 1);
  }
});

test("changed refund totals stop a repeat instead of silently changing the original monetary request", async () => {
  const i = { ...input(), refundedBeforeKopeks: 200 };
  const f = fixture([
    () => json(payment(i, "2.00")),
    () => json(refund(i)),
    () => json(payment(i, "3.01")),
  ]);
  await f.client.createRefund(i);
  await rejected(f.client.createRefund(i), "payment_mismatch");
  assert.equal(f.calls.filter((call) => call.init.method === "POST").length, 1);
});

test("GET wrong saved refund ID, payment relation, metadata, exact amount or status cannot verify", async () => {
  const i = input();
  for (const patch of [
    { id: paymentId },
    { payment_id: refundId },
    { metadata: {} },
    { metadata: { citygo_refund_id: randomUUID() } },
    { amount: { value: "1.00", currency: "RUB" } },
    { amount: { value: "1.010", currency: "RUB" } },
    { amount: { value: "1.01", currency: "USD" } },
    { status: "waiting_for_capture" },
  ]) {
    const f = fixture([
      () => json({ ...refund(i), ...patch }),
      () => json(payment(i, "1.01")),
    ]);
    await rejected(
      f.client.getRefund(refundId, i),
      "invalid_response",
      "observation_failed",
    );
    assert.equal(f.calls.length, 2);
  }
});

test("refund GET still checks original shop, test and cumulative refunded amount", async () => {
  const i = input();
  for (const patch of [
    { recipient: { account_id: "999999" } },
    { test: false },
    { refunded_amount: { value: "0.00", currency: "RUB" } },
    { refunded_amount: { value: "100.02", currency: "RUB" } },
  ]) {
    const f = fixture([
      () => json(refund(i, "succeeded")),
      () => json({ ...payment(i, "1.01"), ...patch }),
    ]);
    await rejected(
      f.client.getRefund(refundId, i),
      "payment_mismatch",
      "observation_failed",
    );
  }
});

test("pending and canceled observations are returned unchanged and do not finalize anything", async () => {
  for (const status of ["pending", "canceled"] as const) {
    const i = input();
    const f = fixture([() => json(refund(i, status)), () => json(payment(i))]);
    const result = await f.client.getRefund(refundId, i);
    assert.equal(result.status, status);
    assert.equal(result.refundedAmountKopeks, 0);
    assert.equal(f.calls.length, 2);
  }
});

test("ambiguous POST repeats only when explicitly invoked and retains the same key and exact body", async () => {
  const i = input();
  const f = fixture([
    () => json(payment(i)),
    () => Promise.reject(new Error("PRIVATE transport response body")),
    () => json(payment(i)),
    () => json(refund(i)),
  ]);
  await rejected(f.client.createRefund(i), "transport", "unknown");
  assert.equal(f.calls.length, 2);
  await f.client.createRefund(i);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[1]!.init.body, f.calls[3]!.init.body);
  assert.equal(
    new Headers(f.calls[1]!.init.headers).get("Idempotence-Key"),
    new Headers(f.calls[3]!.init.headers).get("Idempotence-Key"),
  );
});

test("HTTP and malformed POST responses retain unknown outcome, with sanitized errors and no retry", async () => {
  const i = input();
  for (const [response, code] of [
    [() => new Response("PRIVATE response body", { status: 500 }), "http"],
    [() => new Response("PRIVATE response body"), "invalid_response"],
    [() => json({ private: "PRIVATE" }), "invalid_response"],
    [
      () =>
        new Response("PRIVATE", {
          headers: { "Content-Type": "application/json" },
        }),
      "invalid_response",
    ],
  ] as const) {
    const f = fixture([() => json(payment(i)), response]);
    await rejected(f.client.createRefund(i), code, "unknown");
    assert.equal(f.calls.length, 2);
  }
});

test("redirected and oversized original responses fail before any monetary request", async () => {
  const i = input();
  for (const make of [
    () => json({ ...payment(i), ignored: "a".repeat(65536) }),
    () =>
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "65537",
        },
      }),
    () => {
      const response = json(payment(i));
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
    () => {
      const response = json(payment(i));
      Object.defineProperty(response, "url", { value: "https://PRIVATE.test" });
      return response;
    },
  ]) {
    const f = fixture([make]);
    await rejected(f.client.createRefund(i), "invalid_response");
    assert.equal(f.calls.length, 1);
  }
});

test("one deadline bounds a stalled preflight even if fetch ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture([() => new Promise<Response>(() => {})]);
  const pending = rejected(f.client.createRefund(input()), "timeout");
  t.mock.timers.tick(10_001);
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.init.signal?.aborted, true);
});

test("the same whole-operation deadline bounds POST and marks it unknown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const i = input();
  const f = fixture([
    () => json(payment(i)),
    () => new Promise<Response>(() => {}),
  ]);
  const pending = rejected(f.client.createRefund(i), "timeout", "unknown");
  for (let n = 0; n < 20; n++) await Promise.resolve();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.init.signal, f.calls[1]!.init.signal);
  t.mock.timers.tick(10_001);
  await pending;
  assert.equal(f.calls[1]!.init.signal?.aborted, true);
});

test("late fetch results are bounded and canceled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  let deliver!: (response: Response) => void;
  const i = input();
  const f = fixture([
    () => json(payment(i)),
    () => new Promise<Response>((resolve) => (deliver = resolve)),
  ]);
  const pending = rejected(f.client.createRefund(i), "timeout", "unknown");
  for (let n = 0; n < 20; n++) await Promise.resolve();
  t.mock.timers.tick(10_001);
  await pending;
  deliver(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    ),
  );
  for (let n = 0; n < 10; n++) await Promise.resolve();
  assert.equal(canceled, true);
  assert.equal(f.calls.length, 2);
});

test("a stalled POST body shares the deadline and cannot be treated as a canceled refund", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  const i = input();
  const f = fixture([
    () => json(payment(i)),
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  ]);
  const pending = rejected(f.client.createRefund(i), "timeout", "unknown");
  for (let n = 0; n < 30; n++) await Promise.resolve();
  t.mock.timers.tick(10_001);
  await pending;
  assert.equal(canceled, true);
  assert.equal(f.calls.length, 2);
});

test("in-flight caller mutation cannot change the admitted monetary payload or verification identity", async () => {
  const i = input();
  const original = { ...i };
  let deliver!: (response: Response) => void;
  const f = fixture([
    () => new Promise<Response>((resolve) => (deliver = resolve)),
    () => json(refund(original)),
  ]);
  const pending = f.client.createRefund(i);
  i.amountKopeks = 999;
  i.refundRequestId = randomUUID();
  i.orderId = randomUUID();
  deliver(json(payment(original)));
  const result = await pending;
  assert.equal(result.refundRequestId, original.refundRequestId);
  assert.equal(result.amountKopeks, original.amountKopeks);
  assert.equal(JSON.parse(String(f.calls[1]!.init.body)).amount.value, "1.01");
});

test("an expired persisted create is checked again after preflight, but old refunds remain readable", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const i = {
    ...input(),
    createdAt: new Date(now - 23 * 60 * 60 * 1000 + 500).toISOString(),
  };
  const f = fixture([
    () => {
      t.mock.timers.tick(1_000);
      return json(payment(i));
    },
  ]);
  await rejected(f.client.createRefund(i), "invalid_input");
  assert.equal(f.calls.length, 1);
  const old = { ...i, createdAt: "2025-01-01T00:00:00.000Z" };
  const read = fixture([
    () => json(refund(old, "succeeded")),
    () => json(payment(old, "1.01")),
  ]);
  assert.equal(
    (await read.client.getRefund(refundId, old)).status,
    "succeeded",
  );
});

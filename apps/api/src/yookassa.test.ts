import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  YooKassaClient,
  YooKassaError,
  YooKassaTestClient,
  YooKassaTestError,
  type YooKassaMode,
} from "./yookassa.js";

const orderId = randomUUID();
const paymentId = "2419a771-000f-5000-9000-1edaf29243f2";
const expected = { orderId, amountKopeks: 10_001 };
const shopId = "123456";
const secretKey = "test_SYNTHETIC-NOT-A-REAL-KEY";
const confirmationUrl =
  "https://yoomoney.ru/checkout/payments/v2/contract?orderId=" + paymentId;
const valid = () => ({
  id: paymentId,
  status: "pending",
  paid: false,
  amount: { value: "100.01", currency: "RUB" },
  recipient: { account_id: shopId, gateway_id: "999" },
  metadata: { citygo_order_id: orderId },
  test: true,
  confirmation: { type: "redirect", confirmation_url: confirmationUrl },
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
function fixture(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return {
    calls,
    client: new YooKassaTestClient({ shopId, secretKey, fetch }),
  };
}
async function rejected(
  work: Promise<unknown>,
  code: YooKassaTestError["code"],
) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof YooKassaTestError);
    assert.equal(error.code, code);
    assert.doesNotMatch(
      String(error),
      /SYNTHETIC|123456|Bearer|Basic|2419a771|PRIVATE|response body/i,
    );
    assert.doesNotMatch(
      JSON.stringify(error),
      /SYNTHETIC|123456|Bearer|Basic|2419a771|PRIVATE|response body/i,
    );
    return true;
  });
}

test("test client rejects live keys and malformed configuration without disclosing them", () => {
  for (const options of [
    { shopId, secretKey: "live_PRIVATE-KEY" },
    { shopId: "not-digits", secretKey },
    { shopId, secretKey: "test_" },
    { shopId, secretKey: " test_PRIVATE" },
    { shopId, secretKey: "test_PRIVATE\nsecret" },
    { shopId, secretKey: "test_PRIVATE:key" },
  ])
    assert.throws(
      () => new YooKassaTestClient(options),
      (error: unknown) =>
        error instanceof YooKassaTestError &&
        error.code === "configuration" &&
        !String(error).includes("PRIVATE"),
    );
  const { client } = fixture(() => json(valid()));
  assert.equal(JSON.stringify(client), "{}");
});

test("general client requires explicit mode and matching credentials before any HTTP", () => {
  assert.equal(YooKassaError, YooKassaTestError);
  for (const options of [
    { mode: "live", shopId, secretKey },
    { mode: "test", shopId, secretKey: "live_SYNTHETIC_NOT_REAL" },
    { mode: undefined, shopId, secretKey },
    { mode: "LIVE", shopId, secretKey: "live_SYNTHETIC_NOT_REAL" },
    { mode: "live", shopId: "0", secretKey: "live_SYNTHETIC_NOT_REAL" },
    { mode: "live", shopId, secretKey: "live_" },
    { mode: "live", shopId, secretKey: "live_PRIVATE:key" },
    { mode: "live", shopId, secretKey: "live_PRIVATE\nkey" },
    { mode: "live", shopId, secretKey: " live_PRIVATE_KEY" },
  ])
    assert.throws(
      () =>
        new YooKassaClient(
          options as ConstructorParameters<typeof YooKassaClient>[0],
        ),
      (error: unknown) =>
        error instanceof YooKassaError &&
        error.code === "configuration" &&
        !/PRIVATE|SYNTHETIC/.test(String(error) + JSON.stringify(error)),
    );
  // Extra runtime properties cannot change the sandbox wrapper's fixed mode.
  assert.throws(
    () =>
      new YooKassaTestClient({
        ...{ mode: "live" },
        shopId,
        secretKey: "live_SYNTHETIC_NOT_REAL",
      }),
    YooKassaError,
  );
});

for (const mode of ["test", "live"] as const) {
  const modeKey = mode + "_SYNTHETIC_NOT_REAL";
  const modeResponse = () => ({ ...valid(), test: mode === "test" });
  function modeFixture(response: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new YooKassaClient({
      mode,
      shopId,
      secretKey: modeKey,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response();
      },
    });
    return { client, calls };
  }

  test(`${mode} payment create and independent settlement GET retain exact configured mode`, async () => {
    const raw = modeResponse();
    const f = modeFixture(() => json(raw));
    const created = await f.client.create({
      ...expected,
      returnUrl: "https://citygo.example/balance",
    });
    assert.equal(created.test, mode === "test");
    assert.equal(created.status, "pending");
    assert.equal("credited" in created, false);
    const post = f.calls[0]!;
    assert.equal(post.url, "https://api.yookassa.ru/v3/payments");
    assert.equal(post.init.redirect, "error");
    assert.equal(post.init.credentials, "omit");
    assert.deepEqual(JSON.parse(String(post.init.body)), {
      amount: { value: "100.01", currency: "RUB" },
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: "https://citygo.example/balance",
      },
      description:
        mode === "test"
          ? "Пополнение тестового баланса CityGo"
          : "Пополнение баланса CityGo",
      metadata: { citygo_order_id: orderId },
    });
    assert.equal(
      new Headers(post.init.headers).get("Authorization"),
      "Basic " + Buffer.from(shopId + ":" + modeKey).toString("base64"),
    );
    raw.status = "succeeded";
    raw.paid = true;
    const settled = await f.client.get(paymentId, expected);
    assert.equal(settled.test, mode === "test");
    assert.equal(settled.status, "succeeded");
    assert.equal(f.calls[1]!.init.method, "GET");
    assert.equal(
      new Headers(f.calls[1]!.init.headers).has("Idempotence-Key"),
      false,
    );
    assert.equal(JSON.stringify(f.client), "{}");
  });

  test(`${mode} settlement cannot accept another mode, missing mode or wrong financial binding`, async () => {
    for (const patch of [
      { test: mode !== "test" },
      { test: undefined },
      { test: "false" },
      { id: randomUUID() },
      { recipient: { account_id: "999999" } },
      { metadata: { citygo_order_id: randomUUID() } },
      { amount: { value: "100.00", currency: "RUB" } },
      { refunded_amount: { value: "0.01", currency: "RUB" } },
    ]) {
      const f = modeFixture(() => json({ ...modeResponse(), ...patch }));
      await rejected(f.client.get(paymentId, expected), "invalid_response");
      assert.equal(f.calls.length, 1);
    }
  });

  test(`${mode} HTTP500 and redirection are sanitized, bounded and never automatically retried`, async () => {
    for (const [make, code] of [
      [() => new Response("PRIVATE response body", { status: 500 }), "http"],
      [
        () => {
          const response = json(modeResponse());
          Object.defineProperty(response, "redirected", { value: true });
          return response;
        },
        "invalid_response",
      ],
      [
        () => json({ ...modeResponse(), private: "a".repeat(65_536) }),
        "invalid_response",
      ],
    ] as const) {
      const f = modeFixture(make);
      await rejected(
        f.client.create({
          ...expected,
          returnUrl: "https://citygo.example/balance",
        }),
        code,
      );
      assert.equal(f.calls.length, 1);
    }
  });

  test(`${mode} client cannot change mode through caller configuration mutation`, async () => {
    const options = {
      mode: mode as YooKassaMode,
      shopId,
      secretKey: modeKey,
      fetch: async () => json(modeResponse()),
    };
    const client = new YooKassaClient(options);
    options.mode = mode === "test" ? "live" : "test";
    assert.equal((await client.get(paymentId, expected)).test, mode === "test");
  });
}

test("create uses exact kopeks, fixed endpoint, stable key and server-only Basic credentials", async () => {
  const f = fixture(() =>
    json({
      ...valid(),
      private: "PRIVATE",
      payment_method: { card: { pan: "PRIVATE" } },
    }),
  );
  const input = {
    ...expected,
    returnUrl: "https://pilot.example.test/balance?order=" + orderId,
  };
  const payment = await f.client.create(input);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.url, "https://api.yookassa.ru/v3/payments");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  const headers = new Headers(call.init.headers);
  assert.equal(
    headers.get("Authorization"),
    "Basic " + Buffer.from(shopId + ":" + secretKey).toString("base64"),
  );
  assert.equal(headers.get("Idempotence-Key"), orderId);
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    amount: { value: "100.01", currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: input.returnUrl },
    description: "Пополнение тестового баланса CityGo",
    metadata: { citygo_order_id: orderId },
  });
  assert.equal(payment.confirmationUrl, confirmationUrl);
  assert.equal(payment.amountKopeks, 10_001);
  assert.equal(payment.test, true);
  assert.equal(payment.status, "pending");
  assert.equal(payment.paid, false);
  assert.match(payment.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotMatch(
    JSON.stringify(payment),
    /PRIVATE|SYNTHETIC|Authorization/,
  );
  await f.client.create(input);
  assert.equal(
    new Headers(f.calls[1]!.init.headers).get("Idempotence-Key"),
    orderId,
  );
});

test("GET validates persisted payment identity and distinguishes waiting for capture from success", async () => {
  for (const status of [
    "pending",
    "waiting_for_capture",
    "succeeded",
    "canceled",
  ] as const) {
    const f = fixture(() =>
      json({
        ...valid(),
        status,
        paid: status === "succeeded" || status === "waiting_for_capture",
      }),
    );
    const payment = await f.client.get(paymentId, expected);
    assert.equal(payment.status, status);
    assert.equal(
      f.calls[0]!.url,
      "https://api.yookassa.ru/v3/payments/" + paymentId,
    );
    assert.equal(f.calls[0]!.init.method, "GET");
    assert.equal(f.calls[0]!.init.body, undefined);
    assert.equal(
      new Headers(f.calls[0]!.init.headers).has("Idempotence-Key"),
      false,
    );
  }
});

test("malformed order, amount or return URL never reaches HTTP", async () => {
  const f = fixture(() => json(valid()));
  for (const patch of [
    { orderId: "not-uuid" },
    { amountKopeks: 0 },
    { amountKopeks: -1 },
    { amountKopeks: 1.5 },
    { amountKopeks: Number.NaN },
    { amountKopeks: 1_000_000_001 },
    { returnUrl: "http://pilot.example.test" },
    { returnUrl: "https://user:PRIVATE@pilot.example.test" },
    { returnUrl: "javascript:alert(1)" },
    { returnUrl: "https://pilot.example.test:444/" },
  ])
    await rejected(
      f.client.create({
        ...expected,
        returnUrl: "https://pilot.example.test",
        ...patch,
      }),
      "invalid_input",
    );
  for (const id of [
    "../payments",
    "https://PRIVATE.test",
    paymentId + "?PRIVATE=1",
  ])
    await rejected(f.client.get(id, expected), "invalid_input");
  assert.equal(f.calls.length, 0);
});

test("boundary amounts serialize to fixed two-decimal RUB without floating-point multiplication", async () => {
  for (const [amountKopeks, value] of [
    [1, "0.01"],
    [10, "0.10"],
    [100, "1.00"],
    [1_000_000_000, "10000000.00"],
  ] as const) {
    const f = fixture(() =>
      json({ ...valid(), amount: { value, currency: "RUB" } }),
    );
    assert.equal(
      (
        await f.client.create({
          orderId,
          amountKopeks,
          returnUrl: "https://pilot.example.test",
        })
      ).amountKopeks,
      amountKopeks,
    );
    assert.equal(JSON.parse(String(f.calls[0]!.init.body)).amount.value, value);
  }
});

test("wrong merchant, test/live mode, amount, metadata and payment id cannot yield verified payment", async () => {
  const cases = [
    { ...valid(), id: "PRIVATE" },
    { ...valid(), id: randomUUID() },
    { ...valid(), recipient: { account_id: "654321" } },
    { ...valid(), recipient: {} },
    { ...valid(), test: false },
    { ...valid(), test: "true" },
    { ...valid(), metadata: { citygo_order_id: randomUUID() } },
    { ...valid(), metadata: {} },
    ...["100.00", "100.010", "0100.01", "1e2", "-100.01", "100,01", 100.01].map(
      (value) => ({ ...valid(), amount: { value, currency: "RUB" } }),
    ),
    { ...valid(), amount: { value: "100.01", currency: "USD" } },
    null,
    [],
    {},
    { ...valid(), paid: "true" },
    { ...valid(), status: "succeeded", paid: false },
    { ...valid(), status: "pending", paid: true },
    { ...valid(), status: "waiting_for_capture", paid: false },
    { ...valid(), status: "canceled", paid: true },
    { ...valid(), status: "refunded" },
  ];
  for (const data of cases) {
    const f = fixture(() => json(data));
    await rejected(f.client.get(paymentId, expected), "invalid_response");
    assert.equal(f.calls.length, 1);
  }
});

test("both create and GET validate merchant, exact amount, order and test mode", async () => {
  for (const patch of [
    { test: false },
    { recipient: { account_id: "654321" } },
    { amount: { value: "100.02", currency: "RUB" } },
    { metadata: {} },
  ]) {
    const f = fixture(() => json({ ...valid(), ...patch }));
    await rejected(
      f.client.create({ ...expected, returnUrl: "https://pilot.example.test" }),
      "invalid_response",
    );
  }
});

test("confirmation links reject arbitrary hosts, credentials, custom schemes and nested domains", async () => {
  for (const url of [
    "http://yoomoney.ru/payment",
    "https://yoomoney.ru.PRIVATE.test/payment",
    "https://checkout.yoomoney.ru/payment",
    "https://PRIVATE.test/payment",
    "https://user:PRIVATE@yoomoney.ru/payment",
    "javascript:alert(1)",
    "https://yoomoney.ru:444/payment",
    "https://yoomoney.ru@PRIVATE.test/payment",
  ]) {
    const f = fixture(() =>
      json({
        ...valid(),
        confirmation: { type: "redirect", confirmation_url: url },
      }),
    );
    await rejected(f.client.get(paymentId, expected), "invalid_response");
  }
  const f = fixture(() =>
    json({
      ...valid(),
      confirmation: { type: "embedded", confirmation_token: "PRIVATE" },
    }),
  );
  await rejected(f.client.get(paymentId, expected), "invalid_response");
});

test("HTTP and transport errors expose no upstream body, keys or exceptions, with no implicit retry", async () => {
  for (const status of [301, 400, 401, 403, 404, 429, 500, 503]) {
    const f = fixture(
      () =>
        new Response("PRIVATE response body " + secretKey, {
          status,
          headers: { Location: "https://PRIVATE.test" },
        }),
    );
    await rejected(f.client.get(paymentId, expected), "http");
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => {
    throw new Error("PRIVATE " + secretKey);
  });
  await rejected(f.client.get(paymentId, expected), "transport");
  assert.equal(f.calls.length, 1);
});

test("non-JSON, malformed JSON, redirected and oversized bodies are bounded and rejected", async () => {
  for (const make of [
    () =>
      new Response("PRIVATE response body", {
        headers: { "Content-Type": "text/html" },
      }),
    () =>
      new Response("PRIVATE response body", {
        headers: { "Content-Type": "application/json" },
      }),
    () =>
      new Response("{}", {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(65537),
        },
      }),
    () =>
      new Response(" ".repeat(65537), {
        headers: { "Content-Type": "application/json" },
      }),
    () => {
      const response = json(valid());
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
    () => {
      const response = json(valid());
      Object.defineProperty(response, "url", {
        value: "https://PRIVATE.test/payments",
      });
      return response;
    },
  ]) {
    const f = fixture(make);
    await rejected(f.client.get(paymentId, expected), "invalid_response");
    assert.equal(f.calls.length, 1);
  }
});

test("one ten-second deadline bounds a transport even when fetch ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(() => new Promise<Response>(() => {}));
  const pending = rejected(f.client.get(paymentId, expected), "timeout");
  t.mock.timers.tick(10_001);
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.init.signal?.aborted, true);
});

test("late fetch responses are canceled after the single deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let deliver!: (response: Response) => void;
  let canceled = false;
  const f = fixture(
    () =>
      new Promise<Response>((resolve) => {
        deliver = resolve;
      }),
  );
  const pending = rejected(f.client.get(paymentId, expected), "timeout");
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
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(canceled, true);
  assert.equal(f.calls.length, 1);
});

test("already refunded payments fail closed instead of producing a creditable receipt", async () => {
  for (const refunded_amount of [
    { value: "0.01", currency: "RUB" },
    { value: "100.01", currency: "RUB" },
    { value: "0.00", currency: "USD" },
    {},
    null,
  ]) {
    const f = fixture(() =>
      json({ ...valid(), status: "succeeded", paid: true, refunded_amount }),
    );
    await rejected(f.client.get(paymentId, expected), "invalid_response");
  }
  const f = fixture(() =>
    json({
      ...valid(),
      status: "succeeded",
      paid: true,
      refunded_amount: { value: "0.00", currency: "RUB" },
    }),
  );
  assert.equal((await f.client.get(paymentId, expected)).status, "succeeded");
});

test("the shared deadline also bounds a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  const f = fixture(
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
  );
  const pending = rejected(f.client.get(paymentId, expected), "timeout");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(10_001);
  await pending;
  assert.equal(canceled, true);
});

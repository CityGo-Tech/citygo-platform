import assert from "node:assert/strict";
import test from "node:test";
import {
  createSmsRuDelivery,
  SmsRuDeliveryError,
  type SmsRuDeliveryInput,
  type SmsRuDeliveryOptions,
} from "./sms-ru.js";

// Synthetic fetches only. No service credentials or real SMS endpoint calls.
const endpoint = "https://sms.ru/sms/send";
const phone = "79990000000";
const code = "012345";
const apiId = "SYNTHETIC-SMS-RU-API-ID";
const from = "CityGo";
const id = "000000-10000000";
const success = () => ({
  status: "OK",
  status_code: 100,
  sms: { [phone]: { status: "OK", status_code: 100, sms_id: id } },
  balance: 123.45,
});
const input = (): SmsRuDeliveryInput => ({
  phone,
  code,
  signal: new AbortController().signal,
});
function configured(
  fetch: typeof globalThis.fetch,
  mode: "test" | "live" = "test",
) {
  return { mode, apiId, from, fetch };
}
function failure(code: string, outcome?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SmsRuDeliveryError);
    assert.equal(error.code, code);
    if (outcome) assert.equal(error.outcome, outcome);
    assert.equal(
      error.message,
      "Не удалось отправить код подтверждения телефона.",
    );
    for (const secret of [
      phone,
      apiId,
      "synthetic-private-upstream",
      "secret-invalid-input",
    ])
      assert.ok(!String(error.stack).includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("factory validates explicit mode, private static key and non-default agreed sender before any fetch", () => {
  let calls = 0;
  const valid = configured(async () => {
    calls++;
    return Response.json(success());
  });
  for (const patch of [
    { mode: undefined },
    { mode: "disabled" },
    { mode: "true" },
    { apiId: "" },
    { apiId: "short" },
    { apiId: "key\nSYNTHETIC-PRIVATE" },
    { from: undefined },
    { from: "" },
    { from: " CityGo" },
    { from: "x".repeat(12) },
    { from: "CityGo\n" },
    { from: "https://evil" },
    { from: "СитиГо" },
    { endpoint: "https://untrusted.example.test" },
    { fetch: 1 },
  ])
    assert.throws(
      () =>
        createSmsRuDelivery({
          ...valid,
          ...patch,
        } as unknown as SmsRuDeliveryOptions),
      failure("configuration", "not_dispatched"),
    );
  createSmsRuDelivery(valid);
  assert.equal(calls, 0);
});

test("fixed form request contains one recipient and one-segment OTP, never a query credential or forwarded IP", async () => {
  for (const mode of ["test", "live"] as const) {
    let calls = 0;
    const adapter = createSmsRuDelivery(
      configured(async (url, init) => {
        calls++;
        assert.equal(String(url), endpoint);
        assert.equal(new URL(String(url)).search, "");
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        assert.equal(init?.cache, "no-store");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("accept"), "application/json");
        assert.match(
          headers.get("content-type")!,
          /^application\/x-www-form-urlencoded/,
        );
        assert.ok(init?.signal instanceof AbortSignal);
        const form = new URLSearchParams(String(init?.body));
        assert.deepEqual(
          [...form.keys()].sort(),
          [
            "api_id",
            "from",
            "json",
            "msg",
            "to",
            "ttl",
            ...(mode === "test" ? ["test"] : []),
          ].sort(),
        );
        assert.equal(form.get("api_id"), apiId);
        assert.equal(form.get("to"), phone);
        assert.equal(form.get("from"), from);
        assert.equal(form.get("json"), "1");
        assert.equal(form.get("ttl"), "10");
        assert.equal(form.get("test"), mode === "test" ? "1" : null);
        assert.equal(
          form.get("msg"),
          `CityGo: код подтверждения номера ${code}. Никому не сообщайте.`,
        );
        assert.ok(form.get("msg")!.length <= 70);
        return Response.json(success());
      }, mode),
    );
    const result = await adapter.send(input());
    assert.equal(calls, 1);
    assert.equal(adapter.mode, mode);
    assert.equal(result.mode, mode);
    assert.equal(result.accepted, mode === "live");
    assert.equal(result.simulated, mode === "test");
  }
});

test("test-mode success is an explicit simulation and cannot acquire live accepted/grant shape", async () => {
  const options = configured(async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("test"), "1");
    assert.equal(form.get("api_id"), apiId);
    assert.equal(form.get("from"), from);
    return Response.json(success());
  });
  const adapter = createSmsRuDelivery(options);
  options.mode = "live";
  options.apiId = "SYNTHETIC-MUTATED-API-ID";
  options.from = "Other";
  const result = await adapter.send(input());
  assert.deepEqual(result, {
    provider: "sms_ru",
    mode: "test",
    accepted: false,
    simulated: true,
  });
  assert.equal("providerMessageId" in result, false);
  assert.equal("balance" in result, false);
  assert.equal("cost" in result, false);
});

test("only a fully bound live top-level and single-recipient success returns an accepted ID", async () => {
  const adapter = createSmsRuDelivery(
    configured(async () => Response.json(success()), "live"),
  );
  assert.deepEqual(await adapter.send(input()), {
    provider: "sms_ru",
    mode: "live",
    accepted: true,
    simulated: false,
    providerMessageId: id,
  });
});

test("invalid numbers, lists, OTPs and arbitrary message/IP fields fail before any dispatch", async () => {
  let calls = 0;
  const adapter = createSmsRuDelivery(
    configured(async () => {
      calls++;
      return Response.json(success());
    }),
  );
  for (const phone of [
    "+79990000000",
    "89990000000",
    "77010000000",
    "74991234567",
    "79990000000,79990000001",
    "79990000000;79990000001",
    "79990000000\n",
    "7999",
    "٧٩٩٩٠٠٠٠٠٠٠",
  ])
    await assert.rejects(
      adapter.send({ ...input(), phone }),
      failure("invalid_input", "not_dispatched"),
    );
  for (const code of [
    "12345",
    "1234567",
    " 123456",
    "123456\n",
    "secret-invalid-input",
    "١٢٣٤٥٦",
  ])
    await assert.rejects(
      adapter.send({ ...input(), code }),
      failure("invalid_input", "not_dispatched"),
    );
  for (const patch of [
    { msg: "secret-invalid-input" },
    { ip: "synthetic-IP" },
    { to: [phone] },
    { signal: {} },
  ])
    await assert.rejects(
      adapter.send({ ...input(), ...patch } as SmsRuDeliveryInput),
      failure("invalid_input", "not_dispatched"),
    );
  assert.equal(calls, 0);
});

test("pre-cancelled requests have no transport effects", async () => {
  let calls = 0;
  const adapter = createSmsRuDelivery(
    configured(async () => {
      calls++;
      return Response.json(success());
    }),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adapter.send({ ...input(), signal: controller.signal }),
    failure("aborted", "not_dispatched"),
  );
  assert.equal(calls, 0);
});

test("explicit provider rejection differs from a malformed or partial response, without upstream text", async () => {
  for (const response of [
    {
      status: "ERROR",
      status_code: 201,
      status_text: `synthetic-private-upstream ${apiId} ${phone}`,
    },
    {
      ...success(),
      sms: {
        [phone]: {
          status: "ERROR",
          status_code: 207,
          status_text: "synthetic-private-upstream",
        },
      },
    },
  ])
    await assert.rejects(
      createSmsRuDelivery(
        configured(async () => Response.json(response), "live"),
      ).send(input()),
      failure("rejected", "rejected"),
    );
  for (const response of [
    {},
    null,
    [],
    { ...success(), status_code: "100" },
    { ...success(), status: "ERROR" },
    { ...success(), sms: {} },
    { ...success(), sms: { "79990000001": success().sms[phone] } },
    {
      ...success(),
      sms: { ...success().sms, "79990000001": success().sms[phone] },
    },
    {
      ...success(),
      sms: { [phone]: { status: "OK", status_code: "100", sms_id: id } },
    },
    ...[undefined, "", "synthetic-private-upstream", "123-456\n", 123].map(
      (sms_id) => ({
        ...success(),
        sms: { [phone]: { status: "OK", status_code: 100, sms_id } },
      }),
    ),
  ])
    await assert.rejects(
      createSmsRuDelivery(
        configured(async () => Response.json(response), "live"),
      ).send(input()),
      failure("invalid_response", "unknown"),
    );
});

test("HTTP failures, redirects, wrong media type and malformed JSON remain generic unknown outcomes", async () => {
  const privateBody = `synthetic-private-upstream ${phone} ${apiId}`;
  for (const response of [
    new Response(privateBody, { status: 500 }),
    new Response(privateBody, {
      status: 302,
      headers: { location: "https://untrusted.example.test" },
    }),
  ])
    await assert.rejects(
      createSmsRuDelivery(configured(async () => response)).send(input()),
      failure("http", "unknown"),
    );
  const redirected = Response.json(success());
  Object.defineProperty(redirected, "redirected", { value: true });
  const otherOrigin = Response.json(success());
  Object.defineProperty(otherOrigin, "url", {
    value: "https://untrusted.example.test",
  });
  for (const response of [
    redirected,
    otherOrigin,
    new Response(privateBody),
    new Response(privateBody, {
      headers: { "content-type": "application/json" },
    }),
    new Response(null, { headers: { "content-type": "application/json" } }),
  ])
    await assert.rejects(
      createSmsRuDelivery(configured(async () => response)).send(input()),
      failure("invalid_response", "unknown"),
    );
});

test("declared and streamed responses are capped at 64 KiB and cancelled, never echoed", async () => {
  const declared = Response.json(success(), {
    headers: { "content-length": String(64 * 1024 + 1) },
  });
  await assert.rejects(
    createSmsRuDelivery(configured(async () => declared)).send(input()),
    failure("invalid_response", "unknown"),
  );
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
      controller.enqueue(new TextEncoder().encode("x"));
    },
    cancel() {
      cancelled++;
    },
  });
  await assert.rejects(
    createSmsRuDelivery(
      configured(
        async () =>
          new Response(stream, {
            headers: { "content-type": "application/json" },
          }),
      ),
    ).send(input()),
    failure("invalid_response", "unknown"),
  );
  await Promise.resolve();
  assert.equal(cancelled, 1);
});

test("the fixed eight-second deadline settles even when fetch ignores abort; a late response is cancelled, not retried", async (t) => {
  const transport = deferred<Response>();
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const adapter = createSmsRuDelivery(
    configured(async (_url, init) => {
      calls++;
      signal = init?.signal;
      return transport.promise;
    }, "live"),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sent = adapter.send(input());
    const rejected = assert.rejects(sent, failure("timeout", "unknown"));
    t.mock.timers.tick(7_999);
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal?.aborted, true);
    await rejected;
    let cancelled = 0;
    transport.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cancelled, 1);
    assert.equal(calls, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("body reads share the same fixed deadline and do not wait forever for an upstream cancel", async (t) => {
  const entered = deferred<void>();
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      entered.resolve();
    },
    cancel() {
      cancelled++;
      return new Promise<void>(() => {});
    },
  });
  const adapter = createSmsRuDelivery(
    configured(
      async () =>
        new Response(stream, {
          headers: { "content-type": "application/json" },
        }),
      "live",
    ),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const sent = adapter.send(input());
    const rejected = assert.rejects(sent, failure("timeout", "unknown"));
    await entered.promise;
    // Streams may pull once before any reader is acquired. Wait until this is
    // actually the body-read phase, not merely a pending fetch continuation.
    for (let attempt = 0; attempt < 20 && !stream.locked; attempt++)
      await Promise.resolve();
    assert.equal(stream.locked, true);
    t.mock.timers.tick(8_000);
    await rejected;
    await Promise.resolve();
    assert.equal(cancelled, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("caller cancellation and synchronous abort-then-rejection do not retry or reveal an upstream error", async () => {
  for (const synchronous of [false, true]) {
    const controller = new AbortController();
    const transport = deferred<Response>();
    let calls = 0;
    const adapter = createSmsRuDelivery(
      configured(async () => {
        calls++;
        if (synchronous) {
          controller.abort();
          throw new Error(`synthetic-private-upstream ${apiId}`);
        }
        return transport.promise;
      }),
    );
    const rejected = assert.rejects(
      adapter.send({ ...input(), signal: controller.signal }),
      failure("aborted", "unknown"),
    );
    if (!synchronous) {
      controller.abort();
      transport.reject(new Error(`synthetic-private-upstream ${phone}`));
    }
    await rejected;
    await Promise.resolve();
    assert.equal(calls, 1);
  }
});

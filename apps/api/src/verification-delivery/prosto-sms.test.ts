import assert from "node:assert/strict";
import test from "node:test";
import {
  createProstoSmsDelivery,
  ProstoSmsDeliveryError,
  type ProstoSmsDeliveryInput,
  type ProstoSmsDeliveryOptions,
} from "./prosto-sms.js";

// Synthetic fetches only: no real provider endpoint requests or credentials.
const endpoint = "https://ssl.bs00.ru/";
const phone = "79990000000";
const code = "012345";
const apiKey = "SYNTHETIC-PROSTO-KEY+with/symbols=";
const from = "CityGo";
const id = "21528183";
const success = () => ({
  response: {
    msg: { err_code: "0", type: "message", text: "OK" },
    data: { id: Number(id), credits: "1.78", n_raw_sms: 1, sender_name: from },
  },
});
const input = (): ProstoSmsDeliveryInput => ({
  phone,
  code,
  signal: new AbortController().signal,
});
const options = (fetch: typeof globalThis.fetch): ProstoSmsDeliveryOptions => ({
  apiKey,
  from,
  fetch,
});
function failure(code: string, outcome: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProstoSmsDeliveryError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    assert.equal(
      error.message,
      "Не удалось отправить код подтверждения телефона.",
    );
    assert.equal(error.cause, undefined);
    for (const secret of [
      phone,
      apiKey,
      "synthetic-private-upstream",
      "secret-input",
    ])
      assert.ok(!String(error.stack).includes(secret));
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
const send = (value: unknown) =>
  createProstoSmsDelivery(options(async () => Response.json(value))).send(
    input(),
  );

test("factory requires a private printable key, explicit ASCII sender and fixed live transport", () => {
  let calls = 0;
  const valid = options(async () => {
    calls++;
    return Response.json(success());
  });
  for (const patch of [
    { apiKey: undefined },
    { apiKey: "short" },
    { apiKey: "x".repeat(257) },
    { apiKey: `${apiKey}\n` },
    { apiKey: `${apiKey} ` },
    { apiKey: ` ${apiKey}` },
    { apiKey: `SYNTHETIC\tSECRET-KEY` },
    { apiKey: "секретный-синтетический-ключ" },
    { from: "" },
    { from: undefined },
    { from: "CityGo\n" },
    { from: " CityGo" },
    { from: "City Go" },
    { from: "СитиГо" },
    { from: "x".repeat(12) },
    { from: "https://evil" },
    { from: ".CityGo" },
    { mode: "test" },
    { endpoint: "http://api.sms-prosto.ru/" },
    { fetch: 1 },
  ])
    assert.throws(
      () =>
        createProstoSmsDelivery({
          ...valid,
          ...patch,
        } as ProstoSmsDeliveryOptions),
      failure("configuration", "not_dispatched"),
    );
  for (const key of ["!".repeat(16), "~".repeat(256)])
    createProstoSmsDelivery({ ...valid, apiKey: key, from: "A" });
  assert.equal(calls, 0);
});

test("one fixed HTTPS form sends only one short OTP, without login/password, test, route, IP or idempotency fiction", async () => {
  let calls = 0;
  const mutable = options(async (url, init) => {
    calls++;
    assert.equal(String(url), endpoint);
    assert.equal(new URL(String(url)).search, "");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(
      headers.get("content-type"),
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    const form = new URLSearchParams(String(init?.body));
    assert.deepEqual(
      [...form.keys()].sort(),
      [
        "method",
        "format",
        "key",
        "phone",
        "text",
        "sender_name",
        "priority",
      ].sort(),
    );
    assert.equal(form.get("method"), "push_msg");
    assert.equal(form.get("format"), "json");
    assert.equal(form.get("key"), apiKey);
    assert.equal(form.get("phone"), phone);
    assert.equal(form.get("sender_name"), from);
    assert.equal(form.get("priority"), "1");
    assert.equal(
      form.get("text"),
      `CityGo: код подтверждения номера ${code}. Никому не сообщайте.`,
    );
    assert.ok(form.get("text")!.length <= 70);
    assert.ok(!/[\uD800-\uDFFF]/u.test(form.get("text")!));
    return Response.json(success());
  });
  const adapter = createProstoSmsDelivery(mutable);
  mutable.apiKey = "SYNTHETIC-MUTATED-KEY";
  mutable.from = "Other";
  mutable.fetch = async () => {
    throw new Error("must not replace fetch");
  };
  assert.deepEqual(await adapter.send(input()), {
    provider: "prosto_sms",
    mode: "live",
    accepted: true,
    simulated: false,
    providerMessageId: id,
  });
  assert.equal(adapter.provider, "prosto_sms");
  assert.equal(adapter.mode, "live");
  assert.equal(calls, 1);
});

test("accepted response permits documented numeric/string IDs and costs, never asserts delivery or ownership", async () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER, "1", "9".repeat(32)]) {
    for (const cost of [0, 1.78, "0", "1.78"]) {
      const response = success();
      Object.assign(response.response.msg, { err_code: 0 });
      Object.assign(response.response.data, { id: value, credits: cost });
      const result = await send(response);
      assert.equal(result.providerMessageId, String(value));
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          "provider",
          "mode",
          "accepted",
          "simulated",
          "providerMessageId",
        ].sort(),
      );
    }
  }
});

test("invalid phone, Unicode digits, code, additional recipient/message and arbitrary input fields never dispatch", async () => {
  let calls = 0;
  const adapter = createProstoSmsDelivery(
    options(async () => {
      calls++;
      return Response.json(success());
    }),
  );
  for (const invalid of [
    "+79990000000",
    "89990000000",
    "77010000000",
    "74991234567",
    "79990000000,79990000001",
    `${phone}\n`,
    "٧٩٩٩٠٠٠٠٠٠٠",
    "7999",
  ])
    await assert.rejects(
      adapter.send({ ...input(), phone: invalid }),
      failure("invalid_input", "not_dispatched"),
    );
  for (const invalid of [
    "12345",
    "1234567",
    " 123456",
    "123456\n",
    "١٢٣٤٥٦",
    "secret-input",
  ])
    await assert.rejects(
      adapter.send({ ...input(), code: invalid }),
      failure("invalid_input", "not_dispatched"),
    );
  for (const patch of [
    { text: "secret-input" },
    { ip: "synthetic-IP" },
    { phone: [phone] },
    { signal: {} },
    { route: "tg-sms" },
    { external_id: "synthetic" },
  ])
    await assert.rejects(
      adapter.send({ ...input(), ...patch } as ProstoSmsDeliveryInput),
      failure("invalid_input", "not_dispatched"),
    );
  assert.equal(calls, 0);
});

test("pre-aborted signal never fetches", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const adapter = createProstoSmsDelivery(
    options(async () => {
      calls++;
      return Response.json(success());
    }),
  );
  await assert.rejects(
    adapter.send({ ...input(), signal: controller.signal }),
    failure("aborted", "not_dispatched"),
  );
  assert.equal(calls, 0);
});

test("only documented rejection codes with error/notice type are definite rejections, without provider text", async () => {
  for (const code of [
    3, 5, 7, 602, 605, 607, 608, 609, 610, 611, 617, 618, 620, 621, 622, 623,
    624, 625, 626, 627, 628, 629, 631, 632,
  ])
    for (const type of ["error", "notice"])
      await assert.rejects(
        send({
          response: {
            msg: {
              err_code: String(code),
              type,
              text: `synthetic-private-upstream ${apiKey}`,
            },
            data: null,
          },
        }),
        failure("rejected", "rejected"),
      );
  await assert.rejects(
    send({ response: { msg: { err_code: 623, type: "error" }, data: null } }),
    failure("rejected", "rejected"),
  );
});

test("unfinished99, connection699, unknown codes and contradictory success stay unknown, never retried", async () => {
  for (const err_code of [
    99,
    "99",
    699,
    "699",
    123,
    "000",
    "0\n",
    false,
    null,
    "synthetic-private-upstream",
  ])
    await assert.rejects(
      send({ response: { msg: { err_code, type: "error" }, data: null } }),
      failure("invalid_response", "unknown"),
    );
  for (const msg of [
    { err_code: "0", type: "error" },
    { err_code: "623", type: "message" },
    { err_code: "0", type: "OK" },
  ])
    await assert.rejects(
      send({ response: { ...success().response, msg } }),
      failure("invalid_response", "unknown"),
    );
});

test("partial/wrong envelopes, IDs, multi-segment receipts, invalid costs and substituted senders are never accepted", async () => {
  for (const malformed of [
    null,
    [],
    {},
    { msg: success().response.msg, data: success().response.data },
    { response: null },
    { response: [] },
    { response: { msg: null, data: {} } },
  ])
    await assert.rejects(
      send(malformed),
      failure("invalid_response", "unknown"),
    );
  for (const patch of [
    ...[
      undefined,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "0",
      "01",
      "1\n",
      "+1",
      "1e3",
      "9".repeat(33),
      "",
      "synthetic-private-upstream",
    ].map((id) => ({ id })),
    ...[undefined, "1", 0, 2].map((n_raw_sms) => ({ n_raw_sms })),
    ...[
      undefined,
      null,
      false,
      "",
      " ",
      "-1",
      -1,
      "NaN",
      "Infinity",
      "1e2",
      "1\n",
      {},
      [],
    ].map((credits) => ({ credits })),
    { sender_name: "Other" },
    { sender_name: `${from}\n` },
    { sender_name: undefined },
  ])
    await assert.rejects(
      send({
        response: {
          ...success().response,
          data: { ...success().response.data, ...patch },
        },
      }),
      failure("invalid_response", "unknown"),
    );
});

test("bounded JSON is accepted independently of MIME, but HTML, broken JSON and malformed UTF-8 are not", async () => {
  for (const contentType of [
    undefined,
    "text/plain",
    "text/html",
    "application/json; charset=utf-8",
  ]) {
    const response = new Response(JSON.stringify(success()), {
      headers: contentType ? { "content-type": contentType } : {},
    });
    const result = await createProstoSmsDelivery(
      options(async () => response),
    ).send(input());
    assert.equal(result.providerMessageId, id);
  }
  for (const body of [
    "<script>synthetic-private-upstream</script>",
    "{broken",
    new Uint8Array([0xff]),
    new Uint8Array([0xc3, 0x28]),
  ])
    await assert.rejects(
      createProstoSmsDelivery(options(async () => new Response(body))).send(
        input(),
      ),
      failure("invalid_response", "unknown"),
    );
  await assert.rejects(
    createProstoSmsDelivery(options(async () => new Response(null))).send(
      input(),
    ),
    failure("invalid_response", "unknown"),
  );
});

test("HTTP errors, redirected responses and foreign URLs fail unknown without leaking raw diagnostics", async () => {
  for (const status of [201, 302, 400, 500])
    await assert.rejects(
      createProstoSmsDelivery(
        options(
          async () =>
            new Response(`synthetic-private-upstream ${apiKey}`, { status }),
        ),
      ).send(input()),
      failure("http", "unknown"),
    );
  for (const patch of [
    { redirected: true },
    { url: "https://untrusted.example.test/" },
    { url: `${endpoint}?key=synthetic-private-upstream` },
  ]) {
    const response = Response.json(success());
    for (const [key, value] of Object.entries(patch))
      Object.defineProperty(response, key, { value });
    await assert.rejects(
      createProstoSmsDelivery(options(async () => response)).send(input()),
      failure("invalid_response", "unknown"),
    );
  }
});

test("declared and actual response bytes are capped and reader cleanup cannot overwrite sanitized failure", async () => {
  for (const length of [String(64 * 1024 + 1), "-1", "1e2", "9".repeat(13)])
    await assert.rejects(
      createProstoSmsDelivery(
        options(async () =>
          Response.json(success(), { headers: { "content-length": length } }),
        ),
      ).send(input()),
      failure("invalid_response", "unknown"),
    );
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1));
    },
    cancel() {
      cancelled++;
      throw new Error("synthetic-private-upstream");
    },
  });
  await assert.rejects(
    createProstoSmsDelivery(options(async () => new Response(stream))).send(
      input(),
    ),
    failure("invalid_response", "unknown"),
  );
  await Promise.resolve();
  assert.equal(cancelled, 1);
});

test("success survives best-effort reader cleanup failures", async () => {
  const response = Response.json(success());
  const getReader = response.body!.getReader.bind(response.body!);
  Object.defineProperty(response.body, "getReader", {
    value: () => {
      const reader = getReader();
      Object.defineProperty(reader, "cancel", {
        value: () => {
          throw new Error("synthetic-private-upstream");
        },
      });
      Object.defineProperty(reader, "releaseLock", {
        value: () => {
          throw new Error("synthetic-private-upstream");
        },
      });
      return reader;
    },
  });
  assert.equal(
    (await createProstoSmsDelivery(options(async () => response)).send(input()))
      .providerMessageId,
    id,
  );
});

test("fixed eight-second deadline settles ignoring fetch, cancels a late response and never retries", async (t) => {
  const transport = deferred<Response>();
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const adapter = createProstoSmsDelivery(
    options(async (_url, init) => {
      calls++;
      signal = init?.signal;
      return transport.promise;
    }),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rejection = assert.rejects(
      adapter.send(input()),
      failure("timeout", "unknown"),
    );
    t.mock.timers.tick(7_999);
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal?.aborted, true);
    await rejection;
    let cancelled = 0;
    transport.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cancelled, 1);
    assert.equal(calls, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("body reads share the one deadline even when cancellation never settles", async (t) => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
      return new Promise<void>(() => {});
    },
  });
  const adapter = createProstoSmsDelivery(
    options(async () => new Response(stream)),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rejection = assert.rejects(
      adapter.send(input()),
      failure("timeout", "unknown"),
    );
    for (let attempt = 0; attempt < 30 && !stream.locked; attempt++)
      await Promise.resolve();
    assert.equal(stream.locked, true);
    t.mock.timers.tick(8_000);
    await rejection;
    await Promise.resolve();
    assert.equal(cancelled, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("caller abort, abort-then-reject and synchronous transport exceptions are sanitized once without retry", async () => {
  for (const synchronous of [false, true]) {
    const controller = new AbortController();
    const transport = deferred<Response>();
    let calls = 0;
    const adapter = createProstoSmsDelivery(
      options(async () => {
        calls++;
        if (synchronous) {
          controller.abort();
          throw new Error(`synthetic-private-upstream ${apiKey}`);
        }
        return transport.promise;
      }),
    );
    const rejection = assert.rejects(
      adapter.send({ ...input(), signal: controller.signal }),
      failure("aborted", "unknown"),
    );
    if (!synchronous) {
      controller.abort();
      transport.reject(new Error("synthetic-private-upstream"));
    }
    await rejection;
    assert.equal(calls, 1);
  }
  let calls = 0;
  const adapter = createProstoSmsDelivery(
    options(() => {
      calls++;
      throw new Error("synthetic-private-upstream");
    }),
  );
  await assert.rejects(adapter.send(input()), failure("transport", "unknown"));
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostboxDelivery,
  PostboxDeliveryError,
  type PostboxDeliveryConfig,
  type PostboxDeliveryInput,
} from "./postbox.js";
import { signAwsV4 } from "./signing.js";

const ENDPOINT = "https://postbox.cloud.yandex.net/v2/email/outbound-emails";
const NOW = "2026-10-23T12:00:00.000Z";
const config: PostboxDeliveryConfig = {
  accessKeyId: "syntheticAccessKey",
  secretAccessKey: "syntheticSecret/never-real+",
  fromEmail: "verification@citygo.example",
};
const clock = () => new Date(NOW);
const input = (
  signal = new AbortController().signal,
): PostboxDeliveryInput => ({
  email: "recipient@example.com",
  code: "012345",
  expiresAt: "2026-10-23T12:10:00.000Z",
  signal,
});
const response = (
  body: unknown = { MessageId: "synthetic-message_1" },
  status = 200,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const transport = (
  handler: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetch =>
  (async (url, init) => handler(String(url), init!)) as typeof fetch;
async function rejects(
  promise: Promise<unknown>,
  code: PostboxDeliveryError["code"],
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PostboxDeliveryError);
    assert.equal(error.code, code);
    assert.equal(error.message, "Email delivery could not be confirmed.");
    assert.equal("cause" in error, false);
    const printed = `${String(error)} ${JSON.stringify(error)} ${error.stack}`;
    for (const secret of [
      config.secretAccessKey,
      config.accessKeyId,
      input().email,
      input().code,
      ENDPOINT,
    ]) {
      assert.equal(printed.includes(secret), false);
    }
    return true;
  });
}

test("Postbox construction is inert and sends one signed plaintext OTP to the fixed endpoint", async () => {
  let calls = 0;
  const mutable = { ...config };
  const send = createPostboxDelivery(mutable, {
    clock,
    fetch: transport(async (url, init) => {
      calls++;
      assert.equal(url, ENDPOINT);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.cache, "no-store");
      assert.ok(init.signal instanceof AbortSignal);
      const headers = new Headers(init.headers);
      assert.deepEqual(
        [...headers.keys()],
        ["authorization", "content-type", "host", "x-amz-date"],
      );
      assert.equal(headers.get("x-amz-date"), "20261023T120000Z");
      const body = String(init.body);
      const payload = JSON.parse(body);
      assert.deepEqual(payload, {
        FromEmailAddress: config.fromEmail,
        Destination: { ToAddresses: [input().email] },
        Content: {
          Simple: {
            Subject: { Data: "Код подтверждения CityGo", Charset: "UTF-8" },
            Body: {
              Text: {
                Data: "Код подтверждения CityGo: 012345\nДействителен до 2026-10-23T12:10:00.000Z (UTC).\nЕсли вы не регистрировались в CityGo, проигнорируйте письмо. Никому не сообщайте код.",
                Charset: "UTF-8",
              },
            },
          },
        },
      });
      assert.equal(
        headers.get("authorization"),
        signAwsV4({
          ...config,
          method: "POST",
          path: "/v2/email/outbound-emails",
          region: "ru-central1",
          service: "ses",
          body,
          headers: {
            host: "postbox.cloud.yandex.net",
            "content-type": "application/json",
            "x-amz-date": "20261023T120000Z",
          },
        }),
      );
      return response({
        MessageId: "synthetic-message_1",
        delivered: true,
        verified: true,
      });
    }),
  });
  mutable.fromEmail = "not-the-configured-sender@example.com";
  assert.equal(calls, 0);
  assert.deepEqual(await send(input()), {
    accepted: true,
    provider: "yandex_postbox",
    messageId: "synthetic-message_1",
  });
  assert.equal(calls, 1);
});

test("Postbox rejects unsafe configuration before creating a transport request", () => {
  for (const override of [
    { accessKeyId: "" },
    { accessKeyId: "key/scope" },
    { accessKeyId: "key\r\nInjected" },
    { secretAccessKey: "" },
    { secretAccessKey: "secret\n" },
    { fromEmail: "CityGo <verification@citygo.example>" },
    { fromEmail: "verification@citygo.example\r\nBcc: attacker@example.com" },
    { fromEmail: " verification@citygo.example" },
    { fromEmail: "no-reply@ситиго.рф" },
    { fromEmail: "no-reply@xn--a.example" },
    { fromEmail: "no-reply@xn--abc.example" },
    { fromEmail: "no-reply@xn--c1ajazlh.xn--p1ai." },
    { fromEmail: "no-reply@xn--c1ajazlh.xn--p1ai,other@example.com" },
    {
      fromEmail: "no-reply@xn--c1ajazlh.xn--p1ai\r\nBcc: attacker@example.com",
    },
    { timeoutMs: 0 },
    { timeoutMs: 7_501 },
    { timeoutMs: 1.5 },
  ]) {
    assert.throws(
      () => createPostboxDelivery({ ...config, ...override }),
      (error: unknown) =>
        error instanceof PostboxDeliveryError && error.code === "configuration",
    );
  }
});

test("Postbox preserves an approved ASCII IDN sender in the signed synthetic request", async () => {
  let calls = 0;
  const fromEmail = "no-reply@xn--c1ajazlh.xn--p1ai";
  const send = createPostboxDelivery(
    { ...config, fromEmail },
    {
      clock,
      fetch: transport(async (_url, init) => {
        calls++;
        const body = String(init.body);
        assert.equal(JSON.parse(body).FromEmailAddress, fromEmail);
        assert.equal(
          new Headers(init.headers).get("authorization"),
          signAwsV4({
            ...config,
            method: "POST",
            path: "/v2/email/outbound-emails",
            region: "ru-central1",
            service: "ses",
            body,
            headers: {
              host: "postbox.cloud.yandex.net",
              "content-type": "application/json",
              "x-amz-date": "20261023T120000Z",
            },
          }),
        );
        return response();
      }),
    },
  );
  assert.equal(calls, 0);
  assert.equal((await send(input())).accepted, true);
  assert.equal(calls, 1);
});

test("Postbox validates recipient, six ASCII digits, and a future ISO expiry without sending", async () => {
  let calls = 0;
  const send = createPostboxDelivery(config, {
    clock,
    fetch: transport(async () => {
      calls++;
      return response();
    }),
  });
  for (const override of [
    { email: "a@example.com,b@example.com" },
    { email: "a@example.com\nBcc: attacker@example.com" },
    { email: "Name <a@example.com>" },
    // Sender IDN support must not change registration/recipient validation.
    { email: "recipient@xn--c1ajazlh.xn--p1ai" },
    { code: "12345" },
    { code: "１２３４５６" },
    { code: "123456\n" },
    { code: 123456 as unknown as string },
    { expiresAt: "forever" },
    { expiresAt: "2026-11-31T12:10:00.000Z" },
    { expiresAt: NOW },
    { expiresAt: "2026-10-23T11:59:59Z" },
    { expiresAt: "2026-10-23T12:10:00Z\n" },
  ])
    await rejects(send({ ...input(), ...override }), "input");
  assert.equal(calls, 0);
});

test("Postbox rejects a broken clock without exposing its exception", async () => {
  const send = createPostboxDelivery(config, {
    clock: () => {
      throw new Error(config.secretAccessKey);
    },
    fetch: transport(async () => response()),
  });
  await rejects(send(input()), "configuration");
});

test("Postbox does not start a request for an already aborted caller", async () => {
  const controller = new AbortController();
  controller.abort(config.secretAccessKey);
  let calls = 0;
  const send = createPostboxDelivery(config, {
    clock,
    fetch: transport(async () => {
      calls++;
      return response();
    }),
  });
  await rejects(send(input(controller.signal)), "aborted");
  assert.equal(calls, 0);
});

test("Postbox handles a synchronously aborting and throwing injected transport", async () => {
  const controller = new AbortController();
  const fetch = (() => {
    controller.abort();
    throw new Error(config.secretAccessKey);
  }) as typeof globalThis.fetch;
  await rejects(
    createPostboxDelivery(config, { clock, fetch })(input(controller.signal)),
    "aborted",
  );
  await new Promise<void>((done) => setImmediate(done));
});

test("Postbox caller cancellation bounds a transport ignoring AbortSignal and cancels a late response", async () => {
  let resolve!: (value: Response) => void;
  let requestSignal: AbortSignal | null | undefined;
  let cancelled = false;
  const controller = new AbortController();
  const send = createPostboxDelivery(config, {
    clock,
    fetch: transport(async (_url, init) => {
      requestSignal = init.signal;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    }),
  });
  const pending = send(input(controller.signal));
  controller.abort(config.secretAccessKey);
  await rejects(pending, "aborted");
  assert.equal(requestSignal?.aborted, true);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(cancelled, true);
});

test("Postbox timeout bounds headers even when transport ignores cancellation, with no retries", async () => {
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  const send = createPostboxDelivery(
    { ...config, timeoutMs: 10 },
    {
      clock,
      fetch: transport(async (_url, init) => {
        calls++;
        signal = init.signal;
        return new Promise<Response>(() => {});
      }),
    },
  );
  await rejects(send(input()), "timeout");
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("Postbox timeout and caller abort also bound response streaming and cancel the reader", async () => {
  for (const cause of ["timeout", "aborted"] as const) {
    let cancelled = false;
    const controller = new AbortController();
    const send = createPostboxDelivery(
      { ...config, timeoutMs: 20 },
      {
        clock,
        fetch: transport(
          async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      },
    );
    const pending = send(input(controller.signal));
    if (cause === "aborted") setImmediate(() => controller.abort());
    await rejects(pending, cause);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(cancelled, true);
  }
});

test("Postbox accepts a split, exactly bounded UTF-8 JSON response without trusting delivery fields", async () => {
  const empty = JSON.stringify({ MessageId: "message-at-limit", ignored: "ю" });
  const payload = JSON.stringify({
    MessageId: "message-at-limit",
    ignored: "ю" + "x".repeat(65_536 - Buffer.byteLength(empty)),
  });
  assert.equal(Buffer.byteLength(payload), 65_536);
  const bytes = new TextEncoder().encode(payload);
  const split = bytes.indexOf(0xd1) + 1;
  const send = createPostboxDelivery(config, {
    clock,
    fetch: transport(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split));
              controller.close();
            },
          }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-length": "65536",
            },
          },
        ),
    ),
  });
  assert.deepEqual(await send(input()), {
    accepted: true,
    provider: "yandex_postbox",
    messageId: "message-at-limit",
  });
});

test("Postbox rejects oversized declared and streamed bodies and cancels their streams", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const send = createPostboxDelivery(config, {
      clock,
      fetch: transport(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (!declared) controller.enqueue(new Uint8Array(65_537));
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                "content-type": "application/json",
                ...(declared ? { "content-length": "65537" } : {}),
              },
            },
          ),
      ),
    });
    await rejects(send(input()), "invalid_response");
    assert.equal(cancelled, true);
  }
});

test("Postbox requires exact HTTP 200 and never retries or returns provider details", async () => {
  for (const status of [201, 202, 302, 400, 403, 429, 500, 503]) {
    let calls = 0;
    const send = createPostboxDelivery(config, {
      clock,
      fetch: transport(async () => {
        calls++;
        return response(
          {
            MessageId: "not-accepted",
            error: `${config.secretAccessKey} ${input().email}`,
          },
          status,
        );
      }),
    });
    await rejects(send(input()), "http");
    assert.equal(calls, 1);
  }
});

test("Postbox rejects empty, malformed and missing MessageId responses", async () => {
  for (const body of [
    "",
    "not-json",
    "null",
    "[]",
    "{}",
    ...[null, 1, "", "with space", "\n", "x".repeat(513)].map((MessageId) =>
      JSON.stringify({ MessageId }),
    ),
  ]) {
    const send = createPostboxDelivery(config, {
      clock,
      fetch: transport(
        async () =>
          new Response(body, {
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    await rejects(send(input()), "invalid_response");
  }
});

test("Postbox accepts bounded JSON MessageId independently of response MIME", async () => {
  for (const mime of [
    undefined,
    "text/plain; charset=utf-8",
    "application/x-amz-json-1.1",
    "application/octet-stream",
    "text/html",
    "application/json; charset=utf-8",
  ]) {
    let calls = 0;
    const send = createPostboxDelivery(config, {
      clock,
      fetch: transport(async () => {
        calls++;
        // Uint8Array avoids Response adding text/plain for a string fixture.
        return new Response(
          new TextEncoder().encode(
            '{"MessageId":"synthetic-mime-independent"}',
          ),
          { headers: mime ? { "content-type": mime } : {} },
        );
      }),
    });
    assert.deepEqual(await send(input()), {
      accepted: true,
      provider: "yandex_postbox",
      messageId: "synthetic-mime-independent",
    });
    assert.equal(calls, 1);
  }
});

test("Postbox still rejects non-JSON, malformed MessageId and oversized bodies for non-JSON MIME", async () => {
  for (const mime of [undefined, "text/plain", "text/html"]) {
    for (const body of [
      "<html>not an acknowledgement</html>",
      "not-json",
      "{}",
      '{"MessageId":"with space"}',
      "x".repeat(65_537),
    ]) {
      let calls = 0;
      const send = createPostboxDelivery(config, {
        clock,
        fetch: transport(async () => {
          calls++;
          return new Response(new TextEncoder().encode(body), {
            headers: mime ? { "content-type": mime } : {},
          });
        }),
      });
      await rejects(send(input()), "invalid_response");
      assert.equal(calls, 1);
    }
  }
});

test("Postbox rejects mismatched URLs, redirects, absent bodies and invalid length metadata", async () => {
  const variants = [
    () => {
      const result = response();
      Object.defineProperty(result, "redirected", { value: true });
      return result;
    },
    () => {
      const result = response();
      Object.defineProperty(result, "url", {
        value: "https://attacker.example/",
      });
      return result;
    },
    () =>
      new Response(null, { headers: { "content-type": "application/json" } }),
    () =>
      new Response('{"MessageId":"id"}', {
        headers: {
          "content-type": "application/json",
          "content-length": "invalid",
        },
      }),
    () =>
      new Response('{"MessageId":"id"}', {
        headers: {
          "content-type": "application/json",
          "content-length": "9".repeat(100),
        },
      }),
  ];
  for (const variant of variants) {
    const send = createPostboxDelivery(config, {
      clock,
      fetch: transport(async () => variant()),
    });
    await rejects(send(input()), "invalid_response");
  }
});

test("Postbox reader cleanup cannot replace acceptance or leak exceptions over sanitized failure", async () => {
  for (const method of ["cancel", "releaseLock"] as const) {
    for (const malformed of [false, true]) {
      const send = createPostboxDelivery(config, {
        clock,
        fetch: transport(async () => {
          const result = response();
          const body = malformed
            ? new Response("not-json").body!
            : result.body!;
          const getReader = body.getReader.bind(body);
          body.getReader = (() => {
            const reader = getReader();
            reader[method] = () => {
              throw new Error(`${config.secretAccessKey} ${input().email}`);
            };
            return reader;
          }) as typeof body.getReader;
          return new Response(body);
        }),
      });
      if (malformed) await rejects(send(input()), "invalid_response");
      else assert.equal((await send(input())).accepted, true);
    }
  }
});

test("Postbox sanitizes transport, malformed UTF-8 and reader errors", async () => {
  const variants = [
    transport(async () => {
      throw new Error(`${ENDPOINT} ${config.secretAccessKey} ${input().email}`);
    }),
    transport(
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { "content-type": "application/json" },
        }),
    ),
    transport(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error(config.secretAccessKey));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  ];
  for (const fetch of variants)
    await rejects(
      createPostboxDelivery(config, { clock, fetch })(input()),
      "transport",
    );
});

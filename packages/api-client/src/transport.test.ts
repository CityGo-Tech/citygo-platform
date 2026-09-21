import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  createClient,
  type ClientErrorCode,
  type ClientLimits,
} from "./index.js";

const encoder = new TextEncoder();
const done = 'data:{"type":"done","messageId":"1"}\n\n';
const code = (expected: ClientErrorCode) => (e: unknown) =>
  e instanceof ApiError && e.code === expected;
function sse(body: string | ReadableStream<Uint8Array>) {
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}
function client(
  response: () => Promise<Response>,
  limits?: Partial<ClientLimits>,
) {
  return createClient("http://synthetic", { fetch: response, limits });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("JSON validates completion and discards additive fields, without coercing wrong types", async () => {
  assert.deepEqual(
    await client(async () =>
      Response.json({ awarded: 60, future: true }),
    ).complete("1"),
    { awarded: 60 },
  );
  for (const awarded of ["60", -1, 0.5, null, undefined])
    await assert.rejects(
      client(async () => Response.json({ awarded })).complete("1"),
      code("invalid_response"),
    );
  assert.deepEqual(
    await client(async () => Response.json({ awarded: 0 })).complete("1"),
    { awarded: 0 },
  );
});
test("every JSON method rejects an empty or malformed success envelope", async () => {
  const api = client(async () => Response.json({}));
  const operations = [
    () => api.auth("login", "a@example.test", "synthetic-password"),
    () => api.logout(),
    () => api.dashboard(),
    () => api.admin(),
    () => api.aiControl(),
    () => api.aiConsent({ action: "revoked" }),
    () =>
      api.setAiRouting({
        provider: "disabled",
        policyId: null,
        expectedRevision: 1,
      }),
    () =>
      api.setAiBudget({
        enabled: false,
        currency: "RUB",
        dailyLimitMicros: 0,
        totalLimitMicros: 0,
        expectedRevision: 1,
        rules: [],
      }),
    () =>
      api.questionnaire({
        originCity: "Казань",
        targetCity: "Сочи",
        monthlyBudget: 50000,
        moveTargetDate: "2099-01-01",
        household: "solo",
        aiConsent: true,
      }),
    () => api.start("1"),
    () => api.complete("1"),
  ];
  for (const run of operations)
    await assert.rejects(run(), code("invalid_response"));
});
test("native auth requires a token while browser auth accepts only the user", async () => {
  const fetch = async () =>
    Response.json({ user: { id: "1", email: "a@example.test" } });
  await createClient("http://synthetic", { fetch }).auth("login", "a", "b");
  await assert.rejects(
    createClient("http://synthetic", { fetch, native: true }).auth(
      "login",
      "a",
      "b",
    ),
    code("invalid_response"),
  );
});
test("HTML, malformed JSON, invalid UTF-8 and incorrect error types never expose raw bodies", async () => {
  for (const [response, expected] of [
    [new Response("<script>SECRET</script>"), "invalid_content_type"],
    [
      new Response("{SECRET", {
        headers: { "content-type": "application/json" },
      }),
      "invalid_json",
    ],
    [
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
      "invalid_json",
    ],
    [Response.json({ error: { secret: "SECRET" } }, { status: 502 }), "http"],
    [new Response("<html>SECRET</html>", { status: 503 }), "http"],
  ] as const) {
    await assert.rejects(
      client(async () => response).logout(),
      (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.code, expected);
        assert.ok(!e.message.includes("SECRET"));
        return true;
      },
    );
  }
  await assert.rejects(
    client(async () =>
      Response.json({ error: "Повтор запрещён" }, { status: 409 }),
    ).complete("1"),
    (e: unknown) =>
      e instanceof ApiError &&
      e.status === 409 &&
      e.message === "Повтор запрещён",
  );
});
test("bounded JSON ignores a lying Content-Length and cancels an oversized body", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('{"ok":true,"data":"' + "x".repeat(500)));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "application/json", "content-length": "2" } },
  );
  await assert.rejects(
    client(async () => response, { maxJsonBytes: 64 }).logout(),
    code("response_too_large"),
  );
  assert.equal(cancelled, true);
});
test("JSON deadline covers ignored fetch abort and disposes a late response without retry", async () => {
  const pending = deferred<Response>();
  let calls = 0,
    cancelled = false;
  const api = client(
    async () => {
      calls++;
      return pending.promise;
    },
    { requestTimeoutMs: 15 },
  );
  await assert.rejects(api.complete("1"), code("timeout"));
  pending.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});
test("JSON body stall and an uncooperative cancellation cannot leave an operation pending", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('{"ok":'));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    client(async () => response, { requestTimeoutMs: 15 }).logout(),
    code("timeout"),
  );
  assert.equal(cancelled, true);
});
test("pre-abort makes zero requests; cancellation before headers settles promptly", async () => {
  let calls = 0;
  const abort = new AbortController();
  abort.abort();
  const api = createClient("http://synthetic", {
    signal: () => abort.signal,
    fetch: async () => {
      calls++;
      return Response.json({ ok: true });
    },
  });
  await assert.rejects(api.logout(), code("aborted"));
  assert.equal(calls, 0);
  const active = new AbortController();
  const request = createClient("http://synthetic", {
    signal: () => active.signal,
    fetch: () => new Promise(() => {}),
  }).logout();
  const rejected = assert.rejects(request, code("aborted"));
  active.abort();
  await rejected;
});
test("SSE handles split UTF-8/BOM, CRLF, CR, multiline data and metadata without resending", async () => {
  const bytes = encoder.encode(
    '\uFEFF: heartbeat\r\nid: ignored\r\nretry: 1\r\nevent: message\r\ndata:{"type":"delta",\r\ndata: "text":"Жильё 🏠"}\r\n\r\ndata:{"type":"done","messageId":"1"}\r\r',
  );
  let calls = 0;
  const events: unknown[] = [];
  await client(async () => {
    calls++;
    return sse(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
          c.close();
        },
      }),
    );
  }).stream("1", "test", "uuid", (event) => events.push(event));
  assert.equal(calls, 1);
  assert.deepEqual(events, [
    { type: "delta", text: "Жильё 🏠" },
    { type: "done", messageId: "1" },
  ]);
});
test("valid done settles and cancels immediately even when the server never closes", async () => {
  let cancelled = false;
  const response = sse(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(done));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }),
  );
  await client(async () => response).stream("1", "test", "uuid", () => {});
  assert.equal(cancelled, true);
});
test("malformed and incomplete events cannot produce a false done callback", async () => {
  for (const body of [
    'data:{"type":"done"}\n\n',
    'data:{"type":"done","messageId":4}\n\n',
    'data:{"type":"done","messageId":" "}\n\n',
    'data:{"type":"delta","text":4}\n\n',
    'data:{"type":"unknown"}\n\n',
    "data:SECRET\n\n",
    'data:{"type":"handoff","from":"bad","to":"housing","reason":"test"}\n\n',
    "event:error\n" + done,
    done.trimEnd(),
    ":keepalive\n\n",
  ]) {
    const events: unknown[] = [];
    await assert.rejects(
      client(async () => sse(body)).stream("1", "test", "uuid", (event) =>
        events.push(event),
      ),
    );
    assert.deepEqual(events, []);
  }
});
test("SSE requires the correct Content-Type and valid UTF-8", async () => {
  await assert.rejects(
    client(async () => new Response(done)).stream(
      "1",
      "test",
      "uuid",
      () => {},
    ),
    code("invalid_content_type"),
  );
  const response = sse(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([0xff, 10, 10]));
        c.close();
      },
    }),
  );
  await assert.rejects(
    client(async () => response).stream("1", "test", "uuid", () => {}),
    code("invalid_stream"),
  );
});
test("line, frame, total stream and event counts are bounded including comments", async () => {
  for (const [body, limits] of [
    ["x".repeat(80), { maxFrameBytes: 64 }],
    [":123456789\n".repeat(12), { maxFrameBytes: 64 }],
    // Each CRLF consumes two bytes, including when it ends a comment line.
    [":x\r\n".repeat(16) + ":", { maxFrameBytes: 64 }],
    [":123456789\n\n".repeat(12), { maxStreamBytes: 64 }],
    [
      'data:{"type":"delta","text":""}\n\n'.repeat(3) + done,
      { maxStreamEvents: 2 },
    ],
  ] as [string, Partial<ClientLimits>][]) {
    await assert.rejects(
      client(async () => sse(body), limits).stream(
        "1",
        "test",
        "uuid",
        () => {},
      ),
      code("response_too_large"),
    );
  }
});
test("idle timeout covers stalled headers and body; keepalives cannot extend the absolute deadline", async () => {
  await assert.rejects(
    client(() => new Promise(() => {}), { streamIdleTimeoutMs: 15 }).stream(
      "1",
      "test",
      "uuid",
      () => {},
    ),
    code("idle_timeout"),
  );
  let cancelled = false;
  await assert.rejects(
    client(
      async () =>
        sse(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      { streamIdleTimeoutMs: 15 },
    ).stream("1", "test", "uuid", () => {}),
    code("idle_timeout"),
  );
  assert.equal(cancelled, true);
  let timer: ReturnType<typeof setInterval>;
  const response = sse(
    new ReadableStream({
      start(c) {
        timer = setInterval(
          () => c.enqueue(encoder.encode(": keepalive\n\n")),
          5,
        );
      },
      cancel() {
        clearInterval(timer);
      },
    }),
  );
  await assert.rejects(
    client(async () => response, {
      streamTimeoutMs: 35,
      streamIdleTimeoutMs: 100,
    }).stream("1", "test", "uuid", () => {}),
    code("timeout"),
  );
});
test("server error and consumer exceptions close the stream without replay", async () => {
  await assert.rejects(
    client(async () =>
      sse('data:{"type":"error","message":"Остановлено"}\n\n' + done),
    ).stream("1", "test", "uuid", () => {}),
    code("stream_error"),
  );
  let cancelled = false;
  const response = sse(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data:{"type":"delta","text":"x"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    client(async () => response).stream("1", "test", "uuid", () => {
      throw new Error("consumer failure");
    }),
  );
  assert.equal(cancelled, true);
});
test("limits cannot be disabled or expanded accidentally", () => {
  for (const value of [0, -1, NaN, Infinity, 0.5, 30001])
    assert.throws(() =>
      createClient("/api", { limits: { requestTimeoutMs: value } }),
    );
});

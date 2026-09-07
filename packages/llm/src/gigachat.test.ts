import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GigaChatProvider } from "./gigachat.js";
import { GigaTokenCache, gigaScopes } from "./gigachat-token.js";
import { gigaAuthUrl, type GigaPost } from "./gigachat-http.js";
import type { ModelStreamEvent } from "./provider.js";

const credentials = Buffer.from("test-client:test-secret-not-live").toString(
  "base64",
);
const now = 1800000000000;
const token = (id = "test-access-token", expires = now + 1800000) =>
  Response.json({ access_token: id, expires_at: expires });
const chunk = (content: string, finish_reason?: string) => ({
  model: "GigaChat-test-snapshot",
  choices: [
    {
      index: 0,
      delta: { content },
      ...(finish_reason ? { finish_reason } : {}),
    },
  ],
});
const delta = chunk("Ответ 🏠");
const stop = {
  ...chunk("", "stop"),
  usage: { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 },
};
const sse = (events: unknown[] = [delta, stop, "[DONE]"]) =>
  new Response(
    events
      .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const make = (post: GigaPost, timeoutMs = 60000) =>
  new GigaChatProvider(credentials, "GigaChat-test", {
    scope: "GIGACHAT_API_PERS",
    post,
    now: () => now,
    timeoutMs,
  });
async function collect(
  provider: GigaChatProvider,
  signal = new AbortController().signal,
) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(
    "Housing instructions",
    [{ role: "user", content: "Квартира" }],
    signal,
  ))
    events.push(event);
  return events;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const denied of [false, true]) {
  test(`GigaChat auth retry awaits model-attempt permission (denied=${denied})`, async () => {
    let chats = 0,
      auth = 0,
      guards = 0;
    const provider = make(async (url) => {
      if (url === gigaAuthUrl) {
        auth++;
        return token("token-" + auth);
      }
      chats++;
      return chats === 1 ? new Response("", { status: 401 }) : sse();
    });
    const run = async () => {
      for await (const event of provider.stream(
        "",
        [],
        new AbortController().signal,
        {
          beforeRetry: async () => {
            guards++;
            assert.equal(chats, 1);
            if (denied) throw new Error("test quota");
          },
        },
      )) {
        assert.ok(event);
      }
    };
    if (denied) await assert.rejects(run());
    else await run();
    assert.equal(auth, 2);
    assert.equal(chats, denied ? 1 : 2);
    assert.equal(guards, 1);
  });
}

test("GigaChat has separate OAuth and chat recipients, scope, UUID, limits and cached token", async () => {
  let auth = 0,
    chat = 0;
  const provider = new GigaChatProvider(credentials, "GigaChat-test", {
    scope: "GIGACHAT_API_B2B",
    maxOutputTokens: 900,
    now: () => now,
    post: async (url, init) => {
      assert.ok(init.signal);
      if (url === gigaAuthUrl) {
        auth++;
        assert.equal(init.headers.Authorization, `Basic ${credentials}`);
        assert.match(
          init.headers.RqUID!,
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
        );
        assert.equal(
          init.headers["Content-Type"],
          "application/x-www-form-urlencoded",
        );
        assert.equal(init.body, "scope=GIGACHAT_API_B2B");
        return token();
      }
      chat++;
      assert.equal(url, "https://api.giga.chat/v1/chat/completions");
      assert.equal(init.headers.Authorization, "Bearer test-access-token");
      assert.deepEqual(JSON.parse(init.body), {
        model: "GigaChat-test",
        messages: [
          { role: "system", content: "Housing instructions" },
          { role: "user", content: "Квартира" },
        ],
        stream: true,
        max_tokens: 900,
      });
      return sse();
    },
  });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await collect(provider), [
      { type: "delta", text: "Ответ 🏠" },
      {
        type: "complete",
        model: "GigaChat-test-snapshot",
        usage: { inputTokens: 32, outputTokens: 16 },
      },
    ]);
  assert.equal(auth, 1);
  assert.equal(chat, 2);
});

test("GigaChat shares one refresh across concurrent chats and refreshes before expiry", async () => {
  let current = now,
    auth = 0;
  const gate = deferred<Response>();
  const provider = new GigaChatProvider(credentials, "GigaChat-test", {
    scope: "GIGACHAT_API_CORP",
    now: () => current,
    post: async (url) => {
      if (url !== gigaAuthUrl) return sse();
      auth++;
      return auth === 1 ? gate.promise : token("new-token", current + 1800000);
    },
  });
  const first = collect(provider),
    second = collect(provider);
  assert.equal(auth, 1);
  gate.resolve(token());
  await Promise.all([first, second]);
  current += 1800000 - 59000;
  await Promise.all([collect(provider), collect(provider)]);
  assert.equal(auth, 2);
});

test("cancelling one OAuth waiter leaves other callers alive; cancelling all aborts refresh", async () => {
  const gate = deferred<Response>();
  let authSignal!: AbortSignal;
  const cache = new GigaTokenCache(
    credentials,
    "GIGACHAT_API_PERS",
    async (_url, init) => {
      authSignal = init.signal;
      return gate.promise;
    },
    () => now,
  );
  const a = new AbortController(),
    b = new AbortController();
  const first = cache.get(a.signal),
    second = cache.get(b.signal);
  const failure = assert.rejects(first);
  a.abort();
  await failure;
  assert.equal(authSignal.aborted, false);
  gate.resolve(token());
  assert.equal((await second).value, "test-access-token");

  let calls = 0;
  const alone = new GigaTokenCache(
    credentials,
    "GIGACHAT_API_PERS",
    async (_url, init) => {
      if (++calls > 1) return token();
      authSignal = init.signal;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        ),
      );
    },
    () => now,
  );
  const cancel = new AbortController();
  const pending = assert.rejects(alone.get(cancel.signal));
  cancel.abort();
  await pending;
  assert.equal(authSignal.aborted, true);
  assert.equal(
    (await alone.get(new AbortController().signal)).value,
    "test-access-token",
  );
  assert.equal(calls, 2);
});

test("late invalidation cannot discard a newer token and failed refresh can be retried by a new request", async () => {
  let calls = 0;
  const cache = new GigaTokenCache(
    credentials,
    "GIGACHAT_API_PERS",
    async () => {
      if (++calls === 1) throw new Error("test auth failure");
      return token("test-token-" + calls);
    },
    () => now,
  );
  const signal = new AbortController().signal;
  await assert.rejects(cache.get(signal));
  const old = await cache.get(signal);
  cache.invalidate(old);
  const fresh = await cache.get(signal);
  cache.invalidate(old);
  assert.equal(await cache.get(signal), fresh);
  assert.equal(calls, 3);
});

test("GigaChat allows one token recovery on pre-stream 401, never an infinite retry", async () => {
  for (const recovered of [true, false]) {
    let auth = 0,
      chat = 0;
    const provider = make(async (url, init) => {
      if (url === gigaAuthUrl) return token("test-token-" + ++auth);
      assert.equal(init.headers.Authorization, "Bearer test-token-" + auth);
      return ++chat === 1 || !recovered
        ? new Response("private auth error", { status: 401 })
        : sse();
    });
    if (recovered) await collect(provider);
    else
      await assert.rejects(collect(provider), {
        message: "GigaChat generation failed or was interrupted",
      });
    assert.equal(auth, 2);
    assert.equal(chat, 2);
  }
});

test("GigaChat rejects invalid OAuth bodies, expiry units and status without calling chat", async () => {
  for (const invalid of [
    {},
    { access_token: "", expires_at: now + 1800000 },
    {
      access_token: "test-token",
      expires_at: Math.floor((now + 1800000) / 1000),
    },
    { access_token: "test-token", expires_at: now - 1 },
    { access_token: "test-token", expires_at: now + 30000 },
    { access_token: "test-token", expires_at: String(now + 1800000) },
    { access_token: "test-token", expires_at: now + 1000000000 },
    { access_token: "private\nheader", expires_at: now + 1800000 },
    { access_token: "x".repeat(65000), expires_at: now + 1800000 },
  ]) {
    let calls = 0;
    await assert.rejects(
      collect(
        make(async (url) => {
          calls++;
          assert.equal(url, gigaAuthUrl);
          return Response.json(invalid);
        }),
      ),
      { message: "GigaChat generation failed or was interrupted" },
    );
    assert.equal(calls, 1);
  }
  for (const response of [
    new Response("private auth error", { status: 401 }),
    new Response("private invalid JSON", {
      headers: { "content-type": "application/json" },
    }),
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}"),
  ]) {
    let calls = 0;
    await assert.rejects(
      collect(
        make(async () => {
          calls++;
          return response;
        }),
      ),
    );
    assert.equal(calls, 1);
  }
});

const failures: [string, unknown[]][] = [
  ["EOF", [delta]],
  ["missing DONE", [delta, stop]],
  ["missing stop", [delta, "[DONE]"]],
  ["blacklist", [delta, chunk("", "blacklist"), "[DONE]"]],
  ["length", [delta, chunk("", "length"), "[DONE]"]],
  ["function_call", [delta, chunk("", "function_call"), "[DONE]"]],
  [
    "function delta",
    [
      { ...delta, choices: [{ index: 0, delta: { function_call: {} } }] },
      stop,
      "[DONE]",
    ],
  ],
  [
    "error",
    [
      delta,
      { error: { code: 401, message: "private server error" } },
      "[DONE]",
    ],
  ],
  ["duplicate stop", [delta, stop, stop, "[DONE]"]],
  ["post-stop delta", [delta, stop, delta, "[DONE]"]],
  ["empty answer", [stop, "[DONE]"]],
  ["invalid JSON", [delta, "private broken JSON"]],
];
for (const [label, events] of failures)
  test(`GigaChat ${label} does not complete or retry`, async () => {
    let auth = 0,
      chat = 0;
    const provider = make(async (url) =>
      url === gigaAuthUrl ? (++auth, token()) : (++chat, sse(events)),
    );
    const seen: ModelStreamEvent[] = [];
    await assert.rejects(
      async () => {
        for await (const event of provider.stream(
          "",
          [],
          new AbortController().signal,
        ))
          seen.push(event);
      },
      { message: "GigaChat generation failed or was interrupted" },
    );
    assert.equal(
      seen.some((e) => e.type === "complete"),
      false,
    );
    assert.equal(auth, 1);
    assert.equal(chat, 1);
  });

for (const status of [302, 403, 404, 422, 429, 500, 503])
  test(`GigaChat HTTP ${status} has no generation retry`, async () => {
    let calls = 0;
    await assert.rejects(
      collect(
        make(async (url) => {
          calls++;
          return url === gigaAuthUrl
            ? token()
            : new Response("private response", { status });
        }),
      ),
    );
    assert.equal(calls, 2);
  });

test("GigaChat pre-abort sends nothing; mid-stream abort never refreshes or completes", async () => {
  let calls = 0;
  const provider = make(async (url) => {
    calls++;
    return url === gigaAuthUrl ? token() : sse();
  });
  await assert.rejects(collect(provider, AbortSignal.abort()));
  assert.equal(calls, 0);
  const cancel = new AbortController();
  const stream = provider.stream("", [], cancel.signal);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "delta");
  cancel.abort();
  await assert.rejects(iterator.next());
  assert.equal(calls, 2);
});

test("GigaChat total deadline covers OAuth headers, OAuth body and stalled chat stream", async () => {
  for (const phase of ["oauth-headers", "oauth-body", "chat-body"]) {
    let cancelled = false;
    const provider = make(async (url, init) => {
      if (phase === "oauth-headers")
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          ),
        );
      if (url === gigaAuthUrl && phase === "chat-body") return token();
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            "content-type":
              url === gigaAuthUrl ? "application/json" : "text/event-stream",
          },
        },
      );
    }, 30);
    await Promise.all([assert.rejects(collect(provider)), delay(60)]);
    assert.equal(cancelled, true);
  }
});

test("GigaChat requires explicit account scope, model and unprefixed credentials", () => {
  for (const scope of gigaScopes)
    assert.equal(
      new GigaChatProvider(credentials, "GigaChat-test", { scope }).name,
      "gigachat",
    );
  for (const scope of ["", "pers", "GIGACHAT_API"])
    assert.throws(
      () => new GigaChatProvider(credentials, "GigaChat-test", { scope }),
      /GIGACHAT_SCOPE/,
    );
  for (const key of ["", "Basic abc", "key\nvalue"])
    assert.throws(
      () =>
        new GigaChatProvider(key, "GigaChat-test", {
          scope: "GIGACHAT_API_PERS",
        }),
      /GIGACHAT_CREDENTIALS/,
    );
  for (const model of [
    "",
    "https://api.giga.chat",
    "model@override",
    "model name",
  ])
    assert.throws(
      () =>
        new GigaChatProvider(credentials, model, {
          scope: "GIGACHAT_API_PERS",
        }),
      /GIGACHAT_MODEL/,
    );
});

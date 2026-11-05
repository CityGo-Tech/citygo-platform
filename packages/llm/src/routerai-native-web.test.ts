import assert from "node:assert/strict";
import test from "node:test";
import {
  RouterAIProvider,
  RouterAIInsufficientFundsError,
} from "./routerai.js";
import type { ModelRetryGuard, ModelStreamEvent } from "./provider.js";

const model = "openai/gpt-6.1-sol",
  generation = "gen-native-web-synthetic";
const reference = "1d5120ad-ff1d-45d7-9eab-da42823c52a5";
const text = "Сравните условия по официальному источнику. 🏠";
const citation = (patch: object = {}) => ({
  type: "url_citation",
  url_citation: {
    url: "https://www.mos.ru/news/",
    title: "Официальные новости Москвы",
    start_index: 999999,
    end_index: -1,
    ...patch,
  },
});
const completion = (patch: object = {}) => ({
  id: generation,
  object: "chat.completion",
  model,
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: text,
        annotations: [citation()],
        reasoning: "Private reasoning must not be exposed",
      },
    },
  ],
  usage: { prompt_tokens: 23, completion_tokens: 7, total_tokens: 30 },
  ...patch,
});
const withMessage = (patch: object) =>
  completion({
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { ...completion().choices[0]!.message, ...patch },
      },
    ],
  });
const json = (value: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
const make = (fetch: typeof globalThis.fetch, patch: object = {}) =>
  new RouterAIProvider("synthetic-not-live", model, {
    upstream: "openai",
    country: "us",
    webSearch: { engine: "native", maxResults: 5 },
    fetch,
    ...patch,
  });
async function collect(
  provider: RouterAIProvider,
  guard?: ModelRetryGuard,
  signal = new AbortController().signal,
) {
  const events: ModelStreamEvent[] = [];
  for await (const event of provider.stream(
    "Instructions",
    [
      { role: "user", content: "Old question" },
      { role: "assistant", content: "Old answer" },
      { role: "user", content: "Latest question" },
    ],
    signal,
    guard,
  ))
    events.push(event);
  return events;
}
const rejected = /^Error: RouterAI generation failed or was interrupted$/;

test("native search candidate uses one pinned non-streaming POST and returns only fully validated text and normalized provider sources", async () => {
  let calls = 0,
    retries = 0;
  const ids: string[] = [];
  const provider = make(
    async (url, init) => {
      calls++;
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("accept"),
        "application/json",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-not-live",
      );
      assert.ok(init?.signal);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model,
        messages: [
          { role: "system", content: "Instructions" },
          { role: "user", content: "Old question" },
          { role: "assistant", content: "Old answer" },
          { role: "user", content: "Latest question" },
        ],
        stream: false,
        max_tokens: 32768,
        reasoning: { effort: "high" },
        session_id: reference,
        plugins: [{ id: "web", engine: "native", max_results: 5 }],
        provider: { only: ["openai"], allow_fallbacks: false, country: "us" },
      });
      return json(completion(), { "x-generation-id": generation });
    },
    { maxOutputTokens: 32768, reasoningEffort: "high" },
  );
  const events = await collect(provider, {
    beforeRetry: async () => {
      retries++;
    },
    billing: {
      reference,
      onGeneration: async (id) => {
        ids.push(id);
      },
    },
  });
  assert.deepEqual(events, [
    { type: "delta", text },
    {
      type: "complete",
      model,
      usage: { inputTokens: 23, outputTokens: 7 },
      webSources: {
        version: "routerai_native_v1",
        citations: [
          {
            url: "https://www.mos.ru/news/",
            title: "Официальные новости Москвы",
          },
        ],
      },
    },
  ]);
  assert.deepEqual(ids, [generation]);
  assert.equal(calls, 1);
  assert.equal(retries, 0);
  assert.equal(JSON.stringify(events).includes("reasoning"), false);
  assert.equal(JSON.stringify(events).includes("start_index"), false);
});

test("native search profile rejects unsupported routes, protocols and plugin variants without HTTP", () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  for (const patch of [
    { protocol: "responses" },
    { upstream: "deepseek" },
    { country: "cn" },
    { country: undefined },
    { webSearch: null },
    { webSearch: true },
    { webSearch: [] },
    { webSearch: { engine: "auto", maxResults: 5 } },
    { webSearch: { engine: "native", maxResults: 4 } },
    { webSearch: { engine: "native", maxResults: 5, fallback: true } },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 32769 },
    { maxOutputTokens: NaN },
    { timeoutMs: 0 },
    { timeoutMs: 240001 },
  ])
    assert.throws(() => make(fetch, patch));
  assert.throws(
    () =>
      new RouterAIProvider("synthetic", "deepseek/deepseek-v4-pro-0813", {
        upstream: "openai",
        country: "us",
        webSearch: { engine: "native", maxResults: 5 },
        fetch,
      }),
  );
  assert.equal(calls, 0);
});

test("candidate permits bounded Unicode text and optional usage without publishing raw annotation offsets", async () => {
  const content = "Ж".repeat(127998) + "🏠";
  const events = await collect(
    make(async () => json({ ...withMessage({ content }), usage: undefined })),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: "delta", text: content });
  assert.equal(events[1]!.type, "complete");
  assert.equal("usage" in events[1]!, false);
  assert.equal("start_index" in events[1]!, false);
});

test("candidate routing, plugin, fetch and output settings cannot change through mutable caller options", async () => {
  let calls = 0;
  const options = {
    upstream: "openai",
    country: "us",
    webSearch: { engine: "native" as const, maxResults: 5 as const },
    timeoutMs: 60000,
    maxOutputTokens: 2000,
    fetch: (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.max_tokens, 2000);
      assert.deepEqual(body.provider, {
        only: ["openai"],
        allow_fallbacks: false,
        country: "us",
      });
      assert.deepEqual(body.plugins, [
        { id: "web", engine: "native", max_results: 5 },
      ]);
      return json(completion());
    }) as typeof globalThis.fetch,
  };
  const provider = new RouterAIProvider("synthetic", model, options);
  Object.assign(options, {
    upstream: "other",
    country: "cn",
    maxOutputTokens: 1,
    timeoutMs: 0,
    fetch: async () => {
      throw new Error("mutated fetch must not be called");
    },
  });
  Object.assign(options.webSearch, { engine: "auto", maxResults: 99 });
  assert.equal((await collect(provider)).length, 2);
  assert.equal(calls, 1);
});

test("malformed choices, incomplete answers, wrong identity and unsupported output never emit a delta or trigger retry", async () => {
  const values = [
    null,
    [],
    { id: generation },
    completion({ model: "gpt-6.1-sol" }),
    completion({ model: "other/model" }),
    completion({ error: { message: "private upstream detail" } }),
    completion({ id: undefined }),
    completion({ id: "bad/id" }),
    completion({ object: "chat.completion.chunk" }),
    completion({ choices: [] }),
    completion({ choices: [...completion().choices, ...completion().choices] }),
    completion({ choices: [{ ...completion().choices[0], index: 1 }] }),
    ...["length", "tool_calls", "content_filter", null].map((finish_reason) =>
      completion({ choices: [{ ...completion().choices[0], finish_reason }] }),
    ),
    withMessage({ role: "user" }),
    withMessage({ content: "" }),
    withMessage({ content: " \n " }),
    withMessage({ content: null }),
    withMessage({ content: [{ type: "text", text }] }),
    withMessage({ content: "x".repeat(128001) }),
    withMessage({ content: "bad\ud800" }),
    withMessage({ tool_calls: [] }),
    withMessage({ function_call: {} }),
    withMessage({ refusal: "Refused" }),
    completion({ usage: null }),
    completion({ usage: { prompt_tokens: -1, completion_tokens: 1 } }),
    completion({ usage: { prompt_tokens: 1.1, completion_tokens: 1 } }),
    completion({
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
    }),
  ];
  for (const value of values) {
    let calls = 0,
      retries = 0;
    const emitted: ModelStreamEvent[] = [];
    const provider = make(async () => {
      calls++;
      return json(value);
    });
    await assert.rejects(async () => {
      for await (const event of provider.stream(
        "Instructions",
        [{ role: "user", content: "Question" }],
        new AbortController().signal,
        {
          beforeRetry: async () => {
            retries++;
          },
        },
      ))
        emitted.push(event);
    }, rejected);
    assert.deepEqual(emitted, []);
    assert.equal(calls, 1);
    assert.equal(retries, 0);
  }
});

test("native search requires safe, bounded provider URL annotations and never accepts model-written links as evidence", async () => {
  const annotations: unknown[] = [
    undefined,
    null,
    [],
    "private",
    [null],
    [{ type: "file_citation" }],
    [
      {
        type: "url_citation",
        url: "https://www.mos.ru/",
        title: "Flat shape is not the documented shape",
      },
    ],
    [citation({ url: "http://www.mos.ru/" })],
    [citation({ url: "javascript:alert(1)" })],
    [citation({ url: "file:///etc/passwd" })],
    [citation({ url: "https://user:pass@www.mos.ru/" })],
    [citation({ url: "https://127.0.0.1/a" })],
    [citation({ url: "https://[::1]/" })],
    [citation({ url: "https://localhost/a" })],
    [citation({ url: "https://www.mos.ru/\nsecret" })],
    [citation({ title: "" })],
    [citation({ title: "x".repeat(201) })],
    [citation(), citation({ title: "" })],
    [citation(), citation({ title: "invalid\ntitle" })],
    Array.from({ length: 11 }, (_, index) =>
      citation({ url: `https://www.mos.ru/news/?source=${index}` }),
    ),
    Array.from({ length: 257 }, () => citation()),
    Array.from({ length: 10 }, (_, index) =>
      citation({ url: `https://www.mos.ru/news/${index}/` + "x".repeat(1800) }),
    ),
  ];
  for (const value of annotations) {
    let calls = 0;
    const provider = make(async () => {
      calls++;
      return json(
        withMessage({
          content: "[Model-written link](https://www.mos.ru/)",
          annotations: value,
        }),
      );
    });
    await assert.rejects(collect(provider), rejected);
    assert.equal(calls, 1);
  }
});

test("repeated URL citations remain valid through the raw occurrence bound and use the first title after canonicalization", async () => {
  for (const count of [11, 256]) {
    let calls = 0;
    const annotations = Array.from({ length: count }, (_, index) =>
      citation({
        url:
          index % 2 ? "https://WWW.MOS.RU/news/" : "https://www.mos.ru/news/",
        title: index ? "Another valid occurrence title" : "First source title",
      }),
    );
    const events = await collect(
      make(async () => {
        calls++;
        return json(withMessage({ annotations }));
      }),
    );
    assert.equal(calls, 1);
    assert.deepEqual(events[0], { type: "delta", text });
    const completed = events[1];
    assert.equal(completed?.type, "complete");
    if (completed?.type !== "complete") assert.fail("Missing completion");
    assert.deepEqual(completed.webSources, {
      version: "routerai_native_v1",
      citations: [
        { url: "https://www.mos.ru/news/", title: "First source title" },
      ],
    });
    assert.equal(JSON.stringify(events).includes("start_index"), false);
  }
});

test("generation header and JSON identity are retained before late validation failure, but mismatches cannot complete", async () => {
  for (const [value, headers, expected] of [
    [completion({ model: "wrong/model" }), {}, [generation]],
    [
      withMessage({ annotations: [] }),
      { "x-generation-id": generation },
      [generation],
    ],
    [
      completion({ id: "other-generation" }),
      { "x-generation-id": generation },
      [generation],
    ],
  ] as const) {
    const ids: string[] = [];
    const provider = make(async () => json(value, headers));
    await assert.rejects(
      collect(provider, {
        beforeRetry: async () => {
          throw new Error("no retry");
        },
        billing: {
          reference,
          onGeneration: async (id) => {
            ids.push(id);
          },
        },
      }),
      rejected,
    );
    assert.deepEqual(ids, expected);
  }
});

test("HTTP failures, content type, redirect identity, invalid UTF8 and oversized bodies fail once without raw upstream details", async () => {
  const variants = [
    () => new Response("private upstream detail", { status: 503 }),
    () =>
      new Response("private upstream detail", {
        headers: { "content-type": "text/event-stream" },
      }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("x".repeat(1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
    () => {
      const r = json(completion());
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
    () => {
      const r = json(completion());
      Object.defineProperty(r, "url", { value: "https://other.example/" });
      return r;
    },
  ];
  for (const response of variants) {
    let calls = 0;
    const provider = make(async () => {
      calls++;
      return response();
    });
    await assert.rejects(collect(provider), rejected);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const insufficient = make(async () => {
    calls++;
    return new Response("private upstream detail", { status: 402 });
  });
  await assert.rejects(collect(insufficient), RouterAIInsufficientFundsError);
  assert.equal(calls, 1);
});

test("body cancellation and deadline never publish partial validated-looking JSON or retry a POST", async () => {
  let calls = 0,
    cancelled = 0;
  const abort = new AbortController();
  const provider = make(async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(completion()).slice(0, -1)),
          );
          queueMicrotask(() => abort.abort());
        },
        cancel() {
          cancelled++;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "x-generation-id": generation,
        },
      },
    );
  });
  await assert.rejects(collect(provider, undefined, abort.signal), rejected);
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  let timedCalls = 0;
  const timed = make(
    async () => {
      timedCalls++;
      return new Response(new ReadableStream({ cancel() {} }), {
        headers: { "content-type": "application/json" },
      });
    },
    { timeoutMs: 5 },
  );
  // AbortSignal.timeout is unref'ed; keep this synthetic pending-reader test
  // alive until the deliberately tiny deadline fires.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(collect(timed), rejected);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(timedCalls, 1);
});

test("candidate cannot confirm a customer charge or perform a generation GET; absent option preserves legacy cost rejection of search", async () => {
  let calls = 0;
  const provider = make(async () => {
    calls++;
    return json(completion());
  });
  await assert.rejects(
    provider.readCharge(generation, reference, new AbortController().signal),
    /^Error: RouterAI cost could not be confirmed$/,
  );
  assert.equal(calls, 0);
  const legacy = new RouterAIProvider("synthetic", model, {
    upstream: "openai",
    country: "us",
    fetch: async () => {
      calls++;
      return json({
        data: {
          id: generation,
          session_id: reference,
          model,
          provider: "openai",
          api: "chat/completions",
          source: "api",
          has_web_search: true,
          total_cost: 1,
        },
      });
    },
  });
  await assert.rejects(
    legacy.readCharge(generation, reference, new AbortController().signal),
    /^Error: RouterAI cost could not be confirmed$/,
  );
  assert.equal(calls, 1);
});

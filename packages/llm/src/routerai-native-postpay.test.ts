import assert from "node:assert/strict";
import test from "node:test";
import { RouterAIProvider } from "./routerai.js";
import type { ModelStreamEvent } from "./provider.js";

const reference = "8973ee40-f9b5-4f27-9c17-624a66087fab";
const generation = "gen-native-postpay-synthetic";
const model = "openai/gpt-6.1-sol";
const policy = "routerai-native-total-cost-postpay-test-v1" as const;
const productionPolicy = "routerai-native-total-cost-postpay-v1" as const;
const url = "https://routerai.ru/api/v1/generation?id=" + generation;
const rejected = /^Error: RouterAI cost could not be confirmed$/;
function receipt(
  rawCost = "7.39182831114",
  patch: Record<string, unknown> = {},
) {
  const data = {
    id: generation,
    session_id: reference,
    model,
    provider: "openai",
    api: "chat/completions",
    source: "api",
    has_web_search: true,
    total_cost: 0,
    // Deliberately unrelated counters: full price must not be reconstructed.
    usage: { input_tokens: 1, output_tokens: 1 },
    ...patch,
  };
  return new Response(
    JSON.stringify({ data }).replace(
      '"total_cost":0',
      '"total_cost":' + rawCost,
    ),
    {
      headers: { "content-type": "application/json" },
    },
  );
}
function options(fetch: typeof globalThis.fetch) {
  return {
    upstream: "openai",
    country: "us",
    webSearch: { engine: "native" as const, maxResults: 5 as const },
    nativeWebReceiptPolicy: policy,
    fetch,
  };
}
const read = (provider: RouterAIProvider) =>
  provider.readCharge(generation, reference, new AbortController().signal);

test("explicit native test policy reads the whole exact provider cost once without a generation or fee estimate", async () => {
  let gets = 0;
  const provider = new RouterAIProvider(
    "synthetic-only",
    model,
    options(async (target, init) => {
      gets++;
      assert.equal(target, url);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer synthetic-only",
      );
      return receipt("7.391828311140000000000000000001");
    }),
  );
  const value = await read(provider);
  assert.deepEqual(value, {
    generationId: generation,
    reference,
    model,
    upstream: "openai",
    currency: "RUB",
    costRub: "7.391828311140000000000000000001",
    amountMicros: 7_391_828,
  });
  assert.equal(gets, 1);
});

test("test receipt policy requires the exact native route and an explicit injected transport before any HTTP", () => {
  const fetch = async () => receipt();
  for (const extra of [
    { fetch: undefined },
    { webSearch: undefined },
    { protocol: "responses" },
    { country: "cn" },
    { upstream: "deepseek" },
    { nativeWebReceiptPolicy: "inferred-from-response" },
  ])
    assert.throws(
      () =>
        new RouterAIProvider("synthetic-only", model, {
          ...options(fetch),
          ...extra,
        } as never),
    );
  assert.throws(
    () =>
      new RouterAIProvider("synthetic-only", "openai/other", options(fetch)),
  );
});

test("the original native candidate and ordinary receipt readers still cannot accept native search charges", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return receipt();
  };
  const original = new RouterAIProvider("synthetic-only", model, {
    ...options(transport),
    nativeWebReceiptPolicy: undefined,
  });
  await assert.rejects(read(original), rejected);
  assert.equal(calls, 0);
  const legacy = new RouterAIProvider("synthetic-only", model, {
    upstream: "openai",
    country: "us",
    fetch: transport,
  });
  await assert.rejects(read(legacy), rejected);
  assert.equal(calls, 1);
});

test("mutation cannot upgrade an old candidate or replace a test profile's pinned transport, route or fee policy", async () => {
  let allowed = 0,
    forbidden = 0;
  const initial = options(async () => {
    allowed++;
    return receipt();
  });
  const provider = new RouterAIProvider("synthetic-only", model, initial);
  Object.assign(initial, {
    nativeWebReceiptPolicy: undefined,
    upstream: "deepseek",
    country: "cn",
    protocol: "responses",
    fetch: async () => {
      forbidden++;
      throw Error("Wrong transport");
    },
  });
  assert.equal((await read(provider)).costRub, "7.39182831114");
  assert.equal(allowed, 1);
  assert.equal(forbidden, 0);
  const oldOptions = {
    ...options(async () => {
      forbidden++;
      return receipt();
    }),
    nativeWebReceiptPolicy: undefined,
  };
  const old = new RouterAIProvider("synthetic-only", model, oldOptions);
  Object.assign(oldOptions, { nativeWebReceiptPolicy: policy });
  await assert.rejects(read(old), rejected);
  assert.equal(forbidden, 0);
});

test("every receipt identity and the native search flag must agree; explicit non-RUB cannot be charged", async () => {
  for (const patch of [
    { id: "other" },
    { session_id: "other" },
    { model: "other/model" },
    { provider: "deepseek" },
    { api: "responses" },
    { source: "chat" },
    { has_web_search: false },
    { has_web_search: undefined },
    { currency: "USD" },
    { currency: null },
  ]) {
    let calls = 0;
    const provider = new RouterAIProvider(
      "synthetic-only",
      model,
      options(async () => {
        calls++;
        return receipt("1", patch);
      }),
    );
    await assert.rejects(read(provider), rejected);
    assert.equal(calls, 1);
  }
  const explicitRub = new RouterAIProvider(
    "synthetic-only",
    model,
    options(async () => receipt("1", { currency: "RUB" })),
  );
  assert.equal((await read(explicitRub)).currency, "RUB");
});

test("zero observations and scientific decimal costs retain the existing exact receipt contract", async () => {
  for (const [raw, micros] of [
    ["0", 0],
    ["1e-6", 1],
    ["9e-7", 0],
  ] as const) {
    const provider = new RouterAIProvider(
      "synthetic-only",
      model,
      options(async () => receipt(raw)),
    );
    const value = await read(provider);
    assert.equal(value.costRub, raw);
    assert.equal(value.amountMicros, micros);
  }
  // Whether a completed response may settle is the postpay state machine's job.
});

test("malformed, negative and imprecise cost shapes are refused without retries or raw error reflection", async () => {
  for (const raw of ['"1.25"', "-1", "null", "1e99", "{}"]) {
    let calls = 0;
    const provider = new RouterAIProvider(
      "synthetic-only",
      model,
      options(async () => {
        calls++;
        return receipt(raw);
      }),
    );
    await assert.rejects(read(provider), rejected);
    assert.equal(calls, 1);
  }
  for (const response of [
    () => new Response("synthetic-upstream-private", { status: 503 }),
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () =>
      new Response(JSON.stringify({ data: {}, total_cost: 1 }), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(" ".repeat(65_537), {
        headers: { "content-type": "application/json" },
      }),
  ]) {
    const provider = new RouterAIProvider(
      "synthetic-only",
      model,
      options(async () => response()),
    );
    await assert.rejects(read(provider), rejected);
  }
});

test("redirected or alternate successful endpoint responses are refused and a pre-aborted read makes no HTTP", async () => {
  for (const changed of [
    { redirected: true },
    { url: "https://example.com/receipt" },
  ]) {
    const provider = new RouterAIProvider(
      "synthetic-only",
      model,
      options(async () => {
        const response = receipt();
        for (const [key, value] of Object.entries(changed))
          Object.defineProperty(response, key, { value });
        return response;
      }),
    );
    await assert.rejects(read(provider), rejected);
  }
  let calls = 0;
  const provider = new RouterAIProvider(
    "synthetic-only",
    model,
    options(async () => {
      calls++;
      return receipt();
    }),
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    provider.readCharge(generation, reference, aborted.signal),
    rejected,
  );
  assert.equal(calls, 0);
});

test("production receipt policy accepts either explicit search boolean and uses the same exact full total", async () => {
  for (const hasWebSearch of [true, false]) {
    let calls = 0;
    const provider = new RouterAIProvider("synthetic-only", model, {
      ...options(async () => {
        calls++;
        return receipt("7.39182831114", { has_web_search: hasWebSearch });
      }),
      nativeWebReceiptPolicy: productionPolicy,
    });
    const value = await read(provider);
    assert.equal(value.costRub, "7.39182831114");
    assert.equal(value.amountMicros, 7_391_828);
    assert.equal(calls, 1);
  }
  for (const flag of [undefined, null, "true", 0]) {
    const provider = new RouterAIProvider("synthetic-only", model, {
      ...options(async () => receipt("1", { has_web_search: flag })),
      nativeWebReceiptPolicy: productionPolicy,
    });
    await assert.rejects(read(provider), rejected);
  }
});

test("production native completion may omit sources, but every present annotation is validated regardless of receipt flag", async () => {
  const citation = {
    type: "url_citation",
    url_citation: { url: "https://www.mos.ru/", title: "Москва" },
  };
  for (const annotations of [undefined, [], [citation]]) {
    for (const flag of [true, false]) {
      let posts = 0,
        gets = 0,
        recorded = 0;
      const provider = new RouterAIProvider("synthetic-only", model, {
        ...options(async (_target, init) => {
          if (init?.method === "GET") {
            gets++;
            return receipt("1.25", { has_web_search: flag });
          }
          posts++;
          return Response.json({
            id: generation,
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Синтетический завершённый ответ.",
                  ...(annotations === undefined ? {} : { annotations }),
                },
              },
            ],
          });
        }),
        nativeWebReceiptPolicy: productionPolicy,
      });
      const events: ModelStreamEvent[] = [];
      for await (const event of provider.stream(
        "Synthetic instructions",
        [{ role: "user", content: "Synthetic question" }],
        new AbortController().signal,
        {
          beforeRetry: async () => {
            throw Error("Retry forbidden");
          },
          billing: {
            reference,
            onGeneration: async (id) => {
              assert.equal(id, generation);
              recorded++;
            },
          },
        },
      ))
        events.push(event);
      const completion = events.at(-1)!;
      assert.equal(completion.type, "complete");
      assert.deepEqual(
        completion.type === "complete" ? completion.webSources : undefined,
        annotations?.length
          ? {
              version: "routerai_native_v1",
              citations: [{ url: "https://www.mos.ru/", title: "Москва" }],
            }
          : undefined,
      );
      assert.equal((await read(provider)).costRub, "1.25");
      assert.deepEqual([posts, gets, recorded], [1, 1, 1]);
    }
  }
});

test("optional sources do not forgive malformed present metadata or weaken the old test completion", async () => {
  for (const annotations of [
    null,
    "",
    {},
    [{ type: "other" }],
    [
      {
        type: "url_citation",
        url_citation: { url: "http://localhost/", title: "Unsafe" },
      },
    ],
  ]) {
    let posts = 0;
    const provider = new RouterAIProvider("synthetic-only", model, {
      ...options(async () => {
        posts++;
        return Response.json({
          id: generation,
          model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Synthetic answer",
                annotations,
              },
            },
          ],
        });
      }),
      nativeWebReceiptPolicy: productionPolicy,
    });
    const published: ModelStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of provider.stream(
        "Synthetic",
        [],
        new AbortController().signal,
      ))
        published.push(event);
    });
    assert.equal(posts, 1);
    assert.deepEqual(published, []);
  }
  for (const annotations of [undefined, []]) {
    const provider = new RouterAIProvider(
      "synthetic-only",
      model,
      options(async () =>
        Response.json({
          id: generation,
          model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Synthetic answer",
                annotations,
              },
            },
          ],
        }),
      ),
    );
    await assert.rejects(async () => {
      for await (const event of provider.stream(
        "Synthetic",
        [],
        new AbortController().signal,
      ))
        assert.fail(
          "A strict test completion without citations must not publish " +
            event.type,
        );
    });
  }
});

test("production policy captures ambient transport once; mutating a strict profile cannot upgrade it", async (t) => {
  let selected = 0,
    forbidden = 0;
  t.mock.method(globalThis, "fetch", async () => {
    selected++;
    return receipt("1.25", { has_web_search: false });
  });
  const provider = new RouterAIProvider("synthetic-only", model, {
    ...options(globalThis.fetch),
    fetch: undefined,
    nativeWebReceiptPolicy: productionPolicy,
  });
  t.mock.method(globalThis, "fetch", async () => {
    forbidden++;
    throw Error("Wrong ambient transport");
  });
  assert.equal((await read(provider)).costRub, "1.25");
  const strictOptions = options(async () =>
    receipt("1.25", { has_web_search: false }),
  );
  const strict = new RouterAIProvider("synthetic-only", model, strictOptions);
  Object.assign(strictOptions, { nativeWebReceiptPolicy: productionPolicy });
  await assert.rejects(read(strict), rejected);
  assert.deepEqual([selected, forbidden], [1, 0]);
});

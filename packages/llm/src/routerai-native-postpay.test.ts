import assert from "node:assert/strict";
import test from "node:test";
import { RouterAIProvider } from "./routerai.js";

const reference = "8973ee40-f9b5-4f27-9c17-624a66087fab";
const generation = "gen-native-postpay-synthetic";
const model = "openai/gpt-6.1-sol";
const policy = "routerai-native-total-cost-postpay-test-v1" as const;
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

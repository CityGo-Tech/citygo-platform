import assert from "node:assert/strict";
import test from "node:test";
import { RouterAIProvider } from "./routerai.js";
import { routerAiCostMicros } from "@citygo/contracts";

const reference = "1d5120ad-ff1d-45d7-9eab-da42823c52a5";
const data = {
  id: "gen-test",
  session_id: reference,
  model: "test/model",
  provider: "test-upstream",
  api: "chat/completions",
  source: "api",
  has_web_search: false,
  total_cost: 1.23,
};
const make = (fetch: typeof globalThis.fetch) =>
  new RouterAIProvider("synthetic-not-live", "test/model", {
    upstream: "test-upstream",
    fetch,
  });
test("cost uses a fixed authenticated read endpoint and exact JSON decimal, rounded down", async () => {
  let calls = 0;
  const p = make(async (url, init) => {
    calls++;
    assert.equal(url, "https://routerai.ru/api/v1/generation?id=gen-test");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer synthetic-not-live",
    );
    return new Response(
      JSON.stringify({ data }).replace(
        '"total_cost":1.23',
        '"total_cost":1.234567999999999999',
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  const receipt = await p.readCharge(
    "gen-test",
    reference,
    new AbortController().signal,
  );
  assert.equal(calls, 1);
  assert.equal(receipt.amountMicros, 1234567);
  assert.equal(receipt.costRub, "1.234567999999999999");
  assert.equal(receipt.currency, "RUB");
  for (const [raw, expected] of [
    ["0", 0],
    ["1e-6", 1],
    ["9e-7", 0],
    ["1.000001", 1000001],
    ["1.999999999999", 1999999],
  ] as const)
    assert.equal(routerAiCostMicros(raw), expected);
  for (const raw of ["-1", "NaN", "Infinity", "1e99", "+1", " 1", "1,2"])
    assert.throws(() => routerAiCostMicros(raw));
});

test("mismatched and malformed receipts cannot become a customer charge", async () => {
  for (const patch of [
    { id: "other" },
    { session_id: "other" },
    { model: "other/model" },
    { provider: "other" },
    { source: "chat" },
    { api: "responses" },
    { has_web_search: true },
    { total_cost: -1 },
    { total_cost: "1.23" },
    { total_cost: null },
    { total_cost: undefined },
  ]) {
    let calls = 0;
    const p = make(async () => {
      calls++;
      return Response.json({ data: { ...data, ...patch } });
    });
    await assert.rejects(
      p.readCharge("gen-test", reference, new AbortController().signal),
      /^Error: RouterAI cost could not be confirmed$/,
    );
    assert.equal(calls, 1);
  }
});

test("generation lookup requires an unambiguous data envelope", async () => {
  for (const body of [
    data,
    null,
    [],
    { data: null },
    { data: [] },
    { data: "private" },
    { data, error: "private" },
    { ...data, data },
    { data: { data } },
  ]) {
    const provider = make(async () => Response.json(body));
    await assert.rejects(
      provider.readCharge("gen-test", reference, new AbortController().signal),
      /^Error: RouterAI cost could not be confirmed$/,
    );
  }
});

test("real CN Pro receipt shape preserves exact cost for the x10 tariff", async () => {
  const provider = new RouterAIProvider(
    "synthetic",
    "deepseek/deepseek-v4-pro-0813",
    {
      upstream: "deepseek",
      country: "cn",
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              ...data,
              model: "deepseek/deepseek-v4-pro-0813",
              provider: "deepseek",
              total_cost: 0.09573814426176,
              created_at: "2026-10-20T04:50:56Z",
              latency_ms: 2520,
              usage: { prompt_tokens: 125, completion_tokens: 120 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    },
  );
  const receipt = await provider.readCharge(
    "gen-test",
    reference,
    new AbortController().signal,
  );
  assert.equal(receipt.costRub, "0.09573814426176");
  assert.equal(receipt.amountMicros, 95738);
});

test("cost lookup refuses redirects, invalid HTTP, oversized JSON and cancellation without retry", async () => {
  for (const response of [
    new Response("private provider details", { status: 500 }),
    new Response("{}", { status: 302 }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response(" ".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    let calls = 0;
    const p = make(async () => {
      calls++;
      return response;
    });
    await assert.rejects(
      p.readCharge("gen-test", reference, new AbortController().signal),
      /cost could not be confirmed/,
    );
    assert.equal(calls, 1);
  }
  const abort = new AbortController();
  let cancelled = false;
  const p = make(
    async () =>
      new Response(
        new ReadableStream({
          start() {
            setTimeout(() => abort.abort(), 20);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(
    p.readCharge("gen-test", reference, abort.signal),
    /cost could not be confirmed/,
  );
  assert.equal(cancelled, true);
});

test("billing identity is persisted from header before stream errors and never uses untrusted URL input", async () => {
  const identified: string[] = [];
  const p = make(async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).session_id, reference);
    return new Response('data: {"error":"synthetic"}\n\n', {
      headers: {
        "content-type": "text/event-stream",
        "x-generation-id": "gen-interrupted",
      },
    });
  });
  await assert.rejects(async () => {
    for await (const event of p.stream(
      "instructions",
      [],
      new AbortController().signal,
      {
        beforeRetry: async () => assert.fail("no retry"),
        billing: {
          reference,
          onGeneration: async (id) => {
            identified.push(id);
          },
        },
      },
    ))
      void event;
  }, /generation failed/);
  assert.deepEqual(identified, ["gen-interrupted"]);
  let calls = 0;
  const safe = make(async () => {
    calls++;
    return Response.json(data);
  });
  await assert.rejects(
    safe.readCharge(
      "https://attacker.test/?x",
      reference,
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 0);
});

test("failed identity persistence closes the unread generation stream", async () => {
  let cancelled = false;
  const p = make(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-generation-id": "gen-storage-error",
          },
        },
      ),
  );
  await assert.rejects(async () => {
    for await (const event of p.stream(
      "instructions",
      [],
      new AbortController().signal,
      {
        beforeRetry: async () => assert.fail("no retry"),
        billing: {
          reference,
          onGeneration: async () => {
            throw new Error("synthetic storage error");
          },
        },
      },
    ))
      void event;
  }, /generation failed/);
  assert.equal(cancelled, true);
});

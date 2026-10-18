import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  RouterAIProvider,
  RouterAIInsufficientFundsError,
} from "./routerai.js";
import type { ModelStreamEvent } from "./provider.js";

const chunk = (delta: object, finish_reason: string | null = null) => ({
  model: "test/model-v1",
  choices: [{ index: 0, delta, finish_reason }],
});
const delta = chunk({ content: "Ответ 🏠" });
const stop = chunk({}, "stop");
const usage = {
  model: "test/model-v1",
  choices: [],
  usage: { prompt_tokens: 23, completion_tokens: 7 },
};
const encode = (events: unknown[]) =>
  events
    .map(
      (event) =>
        `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
    )
    .join("");
const sse = (events: unknown[]) =>
  new Response(encode(events), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
const makeProvider = (fetch: typeof globalThis.fetch) =>
  new RouterAIProvider("test-key-not-live", "test/model", {
    upstream: "test-upstream",
    fetch,
  });
async function collect(
  provider: RouterAIProvider,
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

test("RouterAI uses separate credentials, fixed endpoint and explicit routing without fallback", async () => {
  let calls = 0;
  const provider = new RouterAIProvider("test-router-secret", "test/model", {
    upstream: "test-upstream",
    country: "ru",
    maxOutputTokens: 900,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer test-router-secret",
      );
      assert.ok(init?.signal);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "test/model",
        messages: [
          { role: "system", content: "Housing instructions" },
          { role: "user", content: "Квартира" },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 900,
        provider: {
          only: ["test-upstream"],
          allow_fallbacks: false,
          country: "ru",
        },
      });
      return sse([delta, stop, usage, "[DONE]"]);
    },
  });
  assert.equal(provider.name, "routerai");
  assert.equal(provider.model, "test/model");
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "Ответ 🏠" },
    {
      type: "complete",
      model: "test/model-v1",
      usage: { inputTokens: 23, outputTokens: 7 },
    },
  ]);
  assert.equal(calls, 1);
});

test("RouterAI Astra uses an explicit total-output cap and native reasoning effort without sampling or tools", async () => {
  let calls = 0;
  const provider = new RouterAIProvider(
    "synthetic-not-live",
    "openai/gpt-6-astra",
    {
      upstream: "openai",
      country: "us",
      maxOutputTokens: 32768,
      reasoningEffort: "high",
      timeoutMs: 240000,
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
        assert.equal(init?.redirect, "error");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "openai/gpt-6-astra",
          messages: [
            { role: "system", content: "Housing instructions" },
            { role: "user", content: "Квартира" },
          ],
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 32768,
          reasoning_effort: "high",
          provider: { only: ["openai"], allow_fallbacks: false, country: "us" },
        });
        return sse([delta, stop, usage, "[DONE]"]);
      },
    },
  );
  await collect(provider);
  assert.equal(calls, 1);
});

test("RouterAI DeepSeek Pro pins its own recipient and uses max_tokens with reasoning", async () => {
  let calls = 0;
  const model = "deepseek/deepseek-v4-pro-0813";
  const provider = new RouterAIProvider("synthetic-not-live", model, {
    upstream: "deepseek",
    country: "us",
    maxOutputTokens: 32768,
    reasoningEffort: "high",
    timeoutMs: 240000,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://routerai.ru/api/v1/chat/completions");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model,
        messages: [
          { role: "system", content: "Housing instructions" },
          { role: "user", content: "Квартира" },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 32768,
        reasoning: { effort: "high" },
        provider: { only: ["deepseek"], allow_fallbacks: false, country: "us" },
      });
      return sse([
        { ...chunk({ reasoning: "private reasoning", content: null }), model },
        { ...delta, model },
        { ...stop, model },
        { ...usage, model },
        "[DONE]",
      ]);
    },
  });
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "Ответ 🏠" },
    { type: "complete", model, usage: { inputTokens: 23, outputTokens: 7 } },
  ]);
  assert.equal(calls, 1);
});

test("RouterAI legacy models keep max_tokens and omit reasoning unless explicitly configured", async () => {
  for (const configured of [false, true]) {
    const provider = new RouterAIProvider(
      "synthetic-not-live",
      "qwen/qwen3.7-flash",
      {
        upstream: "alibaba",
        ...(configured ? { reasoningEffort: "high" as const } : {}),
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          assert.equal(body.max_tokens, 1400);
          assert.equal(body.max_completion_tokens, undefined);
          assert.equal(body.reasoning_effort, undefined);
          assert.deepEqual(
            body.reasoning,
            configured ? { effort: "high" } : undefined,
          );
          return sse([delta, stop, "[DONE]"]);
        },
      },
    );
    await collect(provider);
  }
});

test("RouterAI constructor rejects unsupported reasoning efforts without leaking values", () => {
  for (const value of ["none", "minimal", "ultra", "synthetic-secret"]) {
    assert.throws(
      () =>
        new RouterAIProvider("test-key", "openai/gpt-6-astra", {
          upstream: "openai",
          reasoningEffort: value as "high",
        }),
      { message: "ROUTERAI_REASONING_EFFORT is not supported" },
    );
  }
});

test("pinned RouterAI quality models permit a visible answer above the legacy cap", async () => {
  for (const model of [
    "openai/gpt-6-astra",
    "deepseek/deepseek-v4-pro-0813",
    "qwen/qwen3.7-flash",
  ]) {
    const provider = new RouterAIProvider("test-key", model, {
      upstream: "test-upstream",
      fetch: async () =>
        sse([chunk({ content: "x".repeat(24001) }), stop, "[DONE]"]),
    });
    if (model !== "qwen/qwen3.7-flash") {
      const events = await collect(provider);
      assert.equal(events.at(-1)!.type, "complete");
    } else {
      await assert.rejects(collect(provider), /RouterAI generation failed/);
    }
  }
});

test("DeepSeek reasoning can exceed the legacy stream budget but visible output remains bounded", async () => {
  const model = "deepseek/deepseek-v4-pro-0813";
  const reasoning = Array.from({ length: 20 }, () =>
    chunk({ reasoning: "r".repeat(60000) }),
  );
  const provider = new RouterAIProvider("test-key", model, {
    upstream: "deepseek",
    fetch: async () => sse([...reasoning, delta, stop, "[DONE]"]),
  });
  assert.equal((await collect(provider)).at(-1)!.type, "complete");
  const oversized = new RouterAIProvider("test-key", model, {
    upstream: "deepseek",
    fetch: async () =>
      sse([
        chunk({ content: "x".repeat(64000) }),
        chunk({ content: "x".repeat(64001) }),
        stop,
        "[DONE]",
      ]),
  });
  await assert.rejects(collect(oversized), /RouterAI generation failed/);
});

test("RouterAI does not invent usage or country and ignores reasoning fields", async () => {
  const provider = makeProvider(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.max_tokens, 1400);
    assert.deepEqual(request.provider, {
      only: ["test-upstream"],
      allow_fallbacks: false,
    });
    return sse([
      chunk({
        role: "assistant",
        content: null,
        reasoning: "private reasoning",
      }),
      delta,
      stop,
      "[DONE]",
    ]);
  });
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "Ответ 🏠" },
    { type: "complete", model: "test/model-v1" },
  ]);
});

test("SSE handles byte-split UTF-8, CRLF, comments, multiline data and closes on DONE", async () => {
  let cancelled = false;
  const text =
    ': heartbeat\r\nevent: message\r\ndata: {"model":"test/model-v1",\r\ndata: "choices":[{"index":0,"delta":{"content":"Дом 🏠"},"finish_reason":"stop"}]}\r\n\r\n' +
    encode(["[DONE]"]);
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const provider = makeProvider(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (offset < bytes.length)
              controller.enqueue(bytes.slice(offset, ++offset));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  assert.deepEqual(await collect(provider), [
    { type: "delta", text: "Дом 🏠" },
    { type: "complete", model: "test/model-v1" },
  ]);
  assert.equal(cancelled, true);
});

const invalidStreams: [string, unknown[]][] = [
  ["EOF before stop", [delta]],
  ["EOF after stop without DONE", [delta, stop]],
  ["DONE without stop", [delta, "[DONE]"]],
  ["empty text", [stop, "[DONE]"]],
  ["whitespace text", [chunk({ content: "  " }), stop, "[DONE]"]],
  [
    "missing model",
    [{ choices: delta.choices }, { choices: stop.choices }, "[DONE]"],
  ],
  ["model changed", [delta, { ...stop, model: "other/model" }, "[DONE]"]],
  ["duplicate stop", [delta, stop, stop, "[DONE]"]],
  ["text after stop", [delta, stop, delta, "[DONE]"]],
  [
    "upstream error",
    [delta, { error: { message: "secret upstream body" } }, "[DONE]"],
  ],
  [
    "choice error",
    [
      delta,
      {
        ...stop,
        choices: [
          { ...stop.choices[0], error: { message: "secret upstream body" } },
        ],
      },
      "[DONE]",
    ],
  ],
  ["tool calls", [chunk({ tool_calls: [{}] }), stop, "[DONE]"]],
  ["function call", [chunk({ function_call: {} }), stop, "[DONE]"]],
  ["refusal", [chunk({ refusal: "not an answer" }), stop, "[DONE]"]],
  ["invalid JSON", [delta, "invalid JSON secret upstream body"]],
  ["missing choices", [{ model: "test/model" }]],
  [
    "multiple choices",
    [{ ...delta, choices: [...delta.choices, ...delta.choices] }],
  ],
  [
    "wrong choice index",
    [{ ...delta, choices: [{ ...delta.choices[0], index: 1 }] }],
  ],
  ["non-text content", [chunk({ content: [] }), stop, "[DONE]"]],
  ["early usage", [usage, delta, stop, "[DONE]"]],
  [
    "invalid usage",
    [
      delta,
      stop,
      { ...usage, usage: { prompt_tokens: -1, completion_tokens: 2 } },
      "[DONE]",
    ],
  ],
  ["excessive output", [chunk({ content: "x".repeat(24001) }), stop, "[DONE]"]],
  ...["length", "content_filter", "tool_calls", "function_call", "unknown"].map(
    (reason) =>
      [reason, [delta, chunk({}, reason), "[DONE]"]] as [string, unknown[]],
  ),
];
for (const [label, events] of invalidStreams) {
  test(`RouterAI rejects ${label} without completion or leaking error details`, async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      calls++;
      return sse(events);
    });
    const received: ModelStreamEvent[] = [];
    await assert.rejects(
      async () => {
        for await (const event of provider.stream(
          "",
          [],
          new AbortController().signal,
        ))
          received.push(event);
      },
      { message: "RouterAI generation failed or was interrupted" },
    );
    assert.equal(
      received.some((event) => event.type === "complete"),
      false,
    );
    assert.equal(calls, 1);
  });
}

for (const status of [401, 402, 404, 429, 500, 503]) {
  test(`RouterAI HTTP ${status} makes one attempt without leaking body`, async () => {
    let calls = 0;
    await assert.rejects(
      collect(
        makeProvider(async () => {
          calls++;
          return new Response("secret upstream body", { status });
        }),
      ),
      { message: "RouterAI generation failed or was interrupted" },
    );
    assert.equal(calls, 1);
  });
}

test("prepaid exhaustion is a redacted non-retryable 402, never inferred from an error body", async () => {
  for (const status of [402, 500]) {
    let posts = 0,
      retries = 0,
      identities = 0;
    const provider = makeProvider(async () => {
      posts++;
      return new Response("PRIVATE 402 insufficient funds secret", {
        status,
        headers: { "x-generation-id": "untrusted-error-identity" },
      });
    });
    await assert.rejects(
      async () => {
        for await (const event of provider.stream(
          "",
          [],
          new AbortController().signal,
          {
            beforeRetry: async () => {
              retries++;
            },
            billing: {
              reference: "synthetic",
              onGeneration: async () => {
                identities++;
              },
            },
          },
        ))
          void event;
      },
      (error: unknown) => {
        assert.equal(
          error instanceof RouterAIInsufficientFundsError,
          status === 402,
        );
        assert.doesNotMatch(String(error), /PRIVATE|secret/);
        return true;
      },
    );
    assert.equal(posts, 1);
    assert.equal(retries, 0);
    if (status === 402) assert.equal(identities, 0);
  }
});

test("RouterAI rejects wrong content type, truncated and oversized SSE frames", async () => {
  for (const response of [
    new Response(encode([delta, stop, "[DONE]"])),
    new Response("data: {}", {
      headers: { "content-type": "text/event-stream" },
    }),
    new Response("data: " + "x".repeat(128 * 1024), {
      headers: { "content-type": "text/event-stream" },
    }),
    new Response("event: error\ndata: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
  ])
    await assert.rejects(collect(makeProvider(async () => response)));
});

test("RouterAI refuses pre-abort and abort after first delta without completing", async () => {
  let calls = 0;
  const provider = makeProvider(async () => {
    calls++;
    return sse([delta, stop, "[DONE]"]);
  });
  await assert.rejects(collect(provider, AbortSignal.abort()));
  assert.equal(calls, 0);
  const abort = new AbortController();
  const stream = provider.stream("", [], abort.signal);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "delta");
  abort.abort();
  await assert.rejects(iterator.next());
  assert.equal(calls, 1);
});

test("RouterAI deadline cancels a stalled body and consumer cancellation releases it", async () => {
  for (const mode of ["deadline", "consumer"] as const) {
    let cancelled = false;
    const provider = new RouterAIProvider("test-key", "test/model", {
      upstream: "test-upstream",
      timeoutMs: 30,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(encode([delta])));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const stream = provider.stream("", [], new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "delta");
    if (mode === "deadline") {
      // Keep Node alive while AbortSignal.timeout's unref'ed timer is active.
      await Promise.all([assert.rejects(iterator.next()), delay(60)]);
    } else await iterator.return?.();
    assert.equal(cancelled, true);
  }
});

test("RouterAI rejects embedded routing and malformed model, provider or country", () => {
  for (const model of [
    "",
    "test",
    "https://example.test/model",
    "test/model@provider=other",
    "test/model?x=1",
    "test/model name",
  ])
    assert.throws(
      () =>
        new RouterAIProvider("test-key", model, { upstream: "test-upstream" }),
      /ROUTERAI_MODEL/,
    );
  for (const upstream of ["", "OpenAI", "test,other", "test/priority", "*"])
    assert.throws(
      () => new RouterAIProvider("test-key", "test/model", { upstream }),
      /ROUTERAI_UPSTREAM/,
    );
  for (const country of ["RU", "russia", "", "*"])
    assert.throws(
      () =>
        new RouterAIProvider("test-key", "test/model", {
          upstream: "test",
          country,
        }),
      /ROUTERAI_COUNTRY/,
    );
});

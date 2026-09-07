import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIProvider } from "./stream.js";
import type { ModelStreamEvent } from "./provider.js";

const delta = { type: "response.output_text.delta", delta: "Ответ" };
const complete = {
  type: "response.completed",
  response: {
    model: "test-model-snapshot",
    usage: { input_tokens: 23, output_tokens: 7 },
  },
};
const sse = (events: unknown[]) =>
  new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const retryable = () =>
  new Response("{}", {
    status: 500,
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });

test("OpenAI authorizes its SDK retry before sending another request", async () => {
  let calls = 0,
    guards = 0;
  const provider = new OpenAIProvider("test-key", "test-model", {
    fetch: async () => (++calls === 1 ? retryable() : sse([delta, complete])),
  });
  const events = await collect(
    provider.stream("", [], new AbortController().signal, {
      beforeRetry: async () => {
        assert.equal(calls, 1);
        guards++;
      },
    }),
  );
  assert.equal(events.at(-1)!.type, "complete");
  assert.equal(calls, 2);
  assert.equal(guards, 1);
});

test("OpenAI denied or cancelled retry never dispatches the second HTTP attempt", async () => {
  for (const cancel of [false, true]) {
    let calls = 0,
      guards = 0;
    const abort = new AbortController();
    const provider = new OpenAIProvider("test-key", "test-model", {
      fetch: async () => {
        calls++;
        return retryable();
      },
    });
    await assert.rejects(
      collect(
        provider.stream("", [], abort.signal, {
          beforeRetry: async () => {
            guards++;
            if (cancel) abort.abort();
            else throw new Error("test limit reached");
          },
        }),
      ),
    );
    assert.equal(calls, 1);
    assert.equal(guards, 1);
  }
});

test("OpenAI retry guards are isolated across concurrent streams on one instance", async () => {
  const calls = new Map<string, number>();
  const guarded: string[] = [];
  const provider = new OpenAIProvider("test-key", "test-model", {
    fetch: async (_url, init) => {
      const id = JSON.parse(String(init?.body)).instructions as string;
      const count = (calls.get(id) ?? 0) + 1;
      calls.set(id, count);
      return count === 1 ? retryable() : sse([delta, complete]);
    },
  });
  await Promise.all(
    ["first", "second"].map((id) =>
      collect(
        provider.stream(id, [], new AbortController().signal, {
          beforeRetry: async () => {
            guarded.push(id);
          },
        }),
      ),
    ),
  );
  assert.deepEqual(guarded.sort(), ["first", "second"]);
  assert.deepEqual([...calls.values()], [2, 2]);
});
async function collect(stream: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("direct OpenAI keeps Responses API, instructions, history, limits and store:false", async () => {
  let calls = 0;
  const provider = new OpenAIProvider("test-key-not-live", "test-model", {
    maxOutputTokens: 900,
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer test-key-not-live",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "test-model",
        instructions: "Housing instructions",
        input: [{ role: "user", content: "Квартира" }],
        stream: true,
        store: false,
        max_output_tokens: 900,
      });
      assert.ok(init?.signal);
      return sse([delta, complete]);
    },
  });
  assert.equal(provider.name, "openai");
  assert.equal(provider.model, "test-model");
  assert.deepEqual(
    await collect(
      provider.stream(
        "Housing instructions",
        [{ role: "user", content: "Квартира" }],
        new AbortController().signal,
      ),
    ),
    [
      { type: "delta", text: "Ответ" },
      {
        type: "complete",
        model: "test-model-snapshot",
        usage: { inputTokens: 23, outputTokens: 7 },
      },
    ],
  );
  assert.equal(calls, 1);
});

test("OpenAI retains the default output limit and does not invent unavailable usage", async () => {
  const provider = new OpenAIProvider("test-key", "test-model", {
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 1400);
      return sse([
        delta,
        { type: "response.completed", response: { model: "test-model" } },
      ]);
    },
  });
  const events = await collect(
    provider.stream("", [], new AbortController().signal),
  );
  assert.deepEqual(events.at(-1), { type: "complete", model: "test-model" });
});

for (const [label, events] of [
  ["EOF without completion", [delta]],
  ["failed response", [delta, { type: "response.failed" }]],
  ["incomplete response", [delta, { type: "response.incomplete" }]],
  ["error event", [delta, { type: "error", message: "test upstream failure" }]],
  ["delta after completion", [delta, complete, delta]],
  ["duplicate completion", [delta, complete, complete]],
  [
    "missing actual model",
    [delta, { type: "response.completed", response: {} }],
  ],
] as const) {
  test(`OpenAI rejects ${label}`, async () => {
    const provider = new OpenAIProvider("test-key", "test-model", {
      fetch: async () => sse([...events]),
    });
    await assert.rejects(
      collect(provider.stream("", [], new AbortController().signal)),
    );
  });
}

test("pre-aborted generation never sends an HTTP request", async () => {
  let calls = 0;
  const provider = new OpenAIProvider("test-key", "test-model", {
    fetch: async () => {
      calls++;
      return sse([delta, complete]);
    },
  });
  await assert.rejects(collect(provider.stream("", [], AbortSignal.abort())));
  assert.equal(calls, 0);
});

test("abort after a delta does not emit completion or retry", async () => {
  const abort = new AbortController();
  let calls = 0;
  const provider = new OpenAIProvider("test-key", "test-model", {
    fetch: async () => {
      calls++;
      return sse([delta, complete]);
    },
  });
  const stream = provider.stream("", [], abort.signal);
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, {
    type: "delta",
    text: "Ответ",
  });
  abort.abort();
  await assert.rejects(iterator.next());
  assert.equal(calls, 1);
});

test("invalid credentials propagate failure without retrying", async () => {
  let calls = 0;
  const provider = new OpenAIProvider("test-key", "test-model", {
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { message: "test invalid key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    },
  });
  await assert.rejects(
    collect(provider.stream("", [], new AbortController().signal)),
  );
  assert.equal(calls, 1);
});

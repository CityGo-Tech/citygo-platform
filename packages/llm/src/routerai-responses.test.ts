import assert from "node:assert/strict";
import test from "node:test";
import {
  RouterAIProvider,
  RouterAIInsufficientFundsError,
} from "./routerai.js";
import { readResponse } from "./responses.js";
import type { ModelRetryGuard, ModelStreamEvent } from "./provider.js";

const model = "openai/gpt-6.1-sol",
  generation = "gen-responses-synthetic",
  messageId = "msg_synthetic";
const reference = "1d5120ad-ff1d-45d7-9eab-da42823c52a5";
const text = "Ответ на последний вопрос 🏠";
const item = (answer = text) => ({
  id: messageId,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: answer, annotations: [] }],
});
const response = (patch: object = {}) => ({
  id: generation,
  model,
  status: "in_progress",
  error: null,
  incomplete_details: null,
  ...patch,
});
const created = () => ({ type: "response.created", response: response() });
const delta = (answer = text) => ({
  type: "response.output_text.delta",
  item_id: messageId,
  output_index: 1,
  content_index: 0,
  delta: answer,
});
const completed = (patch: object = {}) => ({
  type: "response.completed",
  response: response({
    status: "completed",
    output: [{ id: "rs_synthetic", type: "reasoning", summary: [] }, item()],
    usage: { input_tokens: 23, output_tokens: 7, total_tokens: 30 },
    ...patch,
  }),
});
const full = () => [
  created(),
  { type: "response.in_progress", response: response() },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: "rs_synthetic", type: "reasoning", summary: [] },
  },
  {
    type: "response.reasoning_summary_text.delta",
    output_index: 0,
    item_id: "rs_synthetic",
    summary_index: 0,
    delta: "Never expose private reasoning",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { id: "rs_synthetic", type: "reasoning", summary: [] },
  },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: { ...item(), status: "in_progress", content: [] },
  },
  {
    type: "response.content_part.added",
    output_index: 1,
    item_id: messageId,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  },
  delta(),
  {
    type: "response.output_text.done",
    item_id: messageId,
    output_index: 1,
    content_index: 0,
    text,
  },
  {
    type: "response.content_part.done",
    item_id: messageId,
    output_index: 1,
    content_index: 0,
    part: item().content[0],
  },
  { type: "response.output_item.done", output_index: 1, item: item() },
  completed(),
];
const wire = (events: unknown[]) =>
  events
    .map(
      (event) =>
        "data: " +
        (typeof event === "string" ? event : JSON.stringify(event)) +
        "\n\n",
    )
    .join("");
const sse = (events: unknown[], headers: HeadersInit = {}) =>
  new Response(wire(events), {
    headers: { "content-type": "text/event-stream; charset=utf-8", ...headers },
  });
const provider = (fetch: typeof globalThis.fetch, patch: object = {}) =>
  new RouterAIProvider("synthetic-not-live", model, {
    protocol: "responses",
    upstream: "openai",
    country: "us",
    fetch,
    ...patch,
  });
async function collect(input: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of input) events.push(event);
  return events;
}
const run = (
  p: RouterAIProvider,
  guard?: ModelRetryGuard,
  signal = new AbortController().signal,
) =>
  collect(
    p.stream(
      "Instructions",
      [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "latest question" },
      ],
      signal,
      guard,
    ),
  );
const decode = (events: unknown[], patch: object = {}) =>
  collect(
    readResponse(sse(events).body!, new AbortController().signal, {
      expectedModel: model,
      ...patch,
    }),
  );

test("Responses uses its exact endpoint, stateless full input, pinned routing and native output/reasoning fields", async () => {
  let calls = 0,
    retries = 0;
  const ordered: string[] = [];
  const p = provider(
    async (url, init) => {
      calls++;
      assert.equal(url, "https://routerai.ru/api/v1/responses");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer synthetic-not-live",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model,
        instructions: "Instructions",
        input: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "latest question" },
        ],
        store: false,
        stream: true,
        max_output_tokens: 32768,
        reasoning: { effort: "high" },
        session_id: reference,
        provider: { only: ["openai"], allow_fallbacks: false, country: "us" },
      });
      return sse(full(), { "x-generation-id": generation });
    },
    { maxOutputTokens: 32768, reasoningEffort: "high" },
  );
  const events: ModelStreamEvent[] = [];
  for await (const event of p.stream(
    "Instructions",
    [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest question" },
    ],
    new AbortController().signal,
    {
      beforeRetry: async () => {
        retries++;
      },
      billing: {
        reference,
        onGeneration: async (id) => {
          ordered.push(id);
        },
      },
    },
  )) {
    ordered.push(event.type);
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "delta", text },
    { type: "complete", model, usage: { inputTokens: 23, outputTokens: 7 } },
  ]);
  assert.deepEqual(ordered, [generation, "delta", "complete"]);
  assert.equal(calls, 1);
  assert.equal(retries, 0);
});

test("Responses optional DONE is accepted only after actual completion; EOF or text.done never manufacture completion", async () => {
  assert.deepEqual(await decode([...full(), "[DONE]"]), await decode(full()));
  for (const events of [
    [],
    [created()],
    [created(), delta()],
    full().slice(0, -1),
    [created(), delta(), "[DONE]"],
  ])
    await assert.rejects(decode(events));
});

test("Responses model/header/generation binding is persisted before text and rejects conflicting identity without retry", async () => {
  for (const events of [
    [created(), delta()],
    [
      {
        type: "response.created",
        response: response({ model: "other/model" }),
      },
      delta(),
    ],
  ]) {
    const seen: string[] = [],
      emitted: ModelStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of provider(async () =>
        sse(events, { "x-generation-id": "other-generation" }),
      ).stream("i", [], new AbortController().signal, {
        beforeRetry: async () => assert.fail("no retry"),
        billing: {
          reference,
          onGeneration: async (id) => {
            seen.push(id);
          },
        },
      }))
        emitted.push(event);
    });
    assert.deepEqual(seen, ["other-generation"]);
    assert.deepEqual(emitted, []);
  }
  let visible = false;
  await assert.rejects(async () => {
    for await (const event of provider(async () => sse(full())).stream(
      "i",
      [],
      new AbortController().signal,
      {
        beforeRetry: async () => {},
        billing: {
          reference,
          onGeneration: async () => {
            throw new Error("synthetic ledger failure");
          },
        },
      },
    )) {
      if (event.type === "delta") visible = true;
    }
  });
  assert.equal(visible, false);
  await assert.rejects(
    run(
      provider(async () =>
        sse([
          {
            type: "response.created",
            response: response({ model: "other/model" }),
          },
          delta(),
          completed(),
        ]),
      ),
    ),
  );
  await assert.rejects(decode([delta(), created(), completed()]));
});

test("Responses terminal output must exactly match streamed assistant text, model, identity, successful status and usage", async () => {
  for (const patch of [
    { id: "other" },
    { model: "other/model" },
    { status: "incomplete" },
    { error: { code: "synthetic" } },
    { incomplete_details: { reason: "max_output_tokens" } },
    { usage: null },
    { usage: { input_tokens: 1, output_tokens: -1 } },
    { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 99 } },
    { output: [] },
    { output: [item(text + " changed")] },
    { output: [item(), item()] },
    { output: [{ ...item(), role: "user" }] },
    { output: [{ ...item(), status: "incomplete" }] },
  ])
    await assert.rejects(decode([created(), delta(), completed(patch)]));
  for (const event of [
    { type: "response.failed", response: response({ status: "failed" }) },
    {
      type: "response.incomplete",
      response: response({ status: "incomplete" }),
    },
    { type: "error", code: "synthetic", message: "private upstream text" },
  ])
    await assert.rejects(decode([created(), delta(), event]));
  await assert.rejects(
    decode([...full(), { type: "error", message: "after terminal" }]),
  );
  await assert.rejects(decode([...full(), completed()]));
});

test("Responses reasoning is not visible and tools, refusals, unknown events or malformed output coordinates cannot become an answer", async () => {
  const events = await decode(full());
  assert.equal(JSON.stringify(events).includes("private reasoning"), false);
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "call_synthetic",
        type: "function_call",
        arguments: "secret",
      },
    },
    {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 1,
      content_index: 0,
      part: { type: "refusal", refusal: "hidden" },
    },
    { type: "response.refusal.delta", delta: "hidden" },
    { type: "response.web_search_call.completed" },
    { ...delta(), item_id: "" },
    { ...delta(), output_index: -1 },
    { ...delta(), content_index: 1.1 },
    { ...delta(), delta: {} },
  ])
    await assert.rejects(decode([created(), event, completed()]));
  await assert.rejects(
    decode([
      created(),
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: messageId, type: "reasoning" },
      },
      delta(),
      completed(),
    ]),
  );
  await assert.rejects(
    decode([
      created(),
      delta(),
      completed({
        output: [{ id: "call_synthetic", type: "function_call" }, item()],
      }),
    ]),
  );
});

test("Responses sequence/part identity and finalized text cannot silently change", async () => {
  const events = full();
  for (const invalid of [
    [...events.slice(0, 9), delta(" extra"), completed()],
    [...events.slice(0, 9), events[8], completed()],
    [...events.slice(0, 10), events[9], completed()],
    [...events.slice(0, 11), delta(" extra"), completed()],
  ])
    await assert.rejects(decode(invalid));
  await assert.rejects(
    decode(
      full().map((event, i) => ({
        ...event,
        sequence_number: i === 7 ? 1 : i,
      })),
    ),
  );
  await assert.rejects(
    decode([
      created(),
      delta(),
      { ...delta(), item_id: "msg_other" },
      completed(),
    ]),
  );
  await assert.rejects(
    decode([
      created(),
      delta(),
      {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: 1,
        content_index: 0,
        text: "different",
      },
      completed(),
    ]),
  );
  await assert.rejects(
    decode([
      created(),
      delta(),
      {
        type: "response.in_progress",
        response: response({ id: "different-generation" }),
      },
      completed(),
    ]),
  );
});

test("Responses emits normal ordered multiple parts as exactly the completed output", async () => {
  const parts = ["Первая ", "вторая часть 🏠"],
    coordinates = { item_id: messageId, output_index: 1 };
  const message = {
    ...item(),
    content: parts.map((answer) => ({
      type: "output_text",
      text: answer,
      annotations: [],
    })),
  };
  const events: unknown[] = full().slice(0, 6);
  for (const [content_index, answer] of parts.entries()) {
    events.push(
      {
        type: "response.content_part.added",
        ...coordinates,
        content_index,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        ...coordinates,
        content_index,
        delta: answer.slice(0, 3),
      },
      {
        type: "response.output_text.delta",
        ...coordinates,
        content_index,
        delta: answer.slice(3),
      },
      {
        type: "response.output_text.done",
        ...coordinates,
        content_index,
        text: answer,
      },
      {
        type: "response.content_part.done",
        ...coordinates,
        content_index,
        part: message.content[content_index],
      },
    );
  }
  const output = [
    { id: "rs_synthetic", type: "reasoning", summary: [] },
    message,
  ];
  events.push(
    { type: "response.output_item.done", output_index: 1, item: message },
    completed({ output }),
  );
  const decoded = await decode(events);
  assert.equal(
    decoded
      .filter((event) => event.type === "delta")
      .map((event) => event.text)
      .join(""),
    parts.join(""),
  );
  assert.deepEqual(decoded.at(-1), {
    type: "complete",
    model,
    usage: { inputTokens: 23, outputTokens: 7 },
  });
});

test("Responses rejects reordered or interleaved parts and inconsistent part/item completion without confirming another text", async () => {
  const coordinates = { item_id: messageId, output_index: 1 };
  const partDelta = (content_index: number, answer: string) => ({
    type: "response.output_text.delta",
    ...coordinates,
    content_index,
    delta: answer,
  });
  const partDone = (content_index: number, answer: string) => ({
    type: "response.content_part.done",
    ...coordinates,
    content_index,
    part: { type: "output_text", text: answer },
  });
  const message = {
    ...item(),
    content: ["FIRST", "SECOND"].map((answer) => ({
      type: "output_text",
      text: answer,
    })),
  };
  const terminal = completed({
    output: [{ id: "rs_synthetic", type: "reasoning", summary: [] }, message],
  });
  // Original regression: every indexed part matched, but the actual visible /
  // persisted concatenation was SECONDFIRST while final output said FIRSTSECOND.
  const observed: ModelStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of readResponse(
      sse([created(), partDelta(1, "SECOND"), partDelta(0, "FIRST"), terminal])
        .body!,
      new AbortController().signal,
      { expectedModel: model },
    ))
      observed.push(event);
  });
  assert.deepEqual(
    observed,
    [],
    "Reject reordered first text before exposing it",
  );

  for (const events of [
    [
      created(),
      partDelta(0, "FI"),
      partDelta(1, "SECOND"),
      partDelta(0, "RST"),
      terminal,
    ],
    [
      created(),
      partDelta(0, "FIRST"),
      {
        type: "response.output_text.done",
        ...coordinates,
        content_index: 0,
        text: "FIRST",
      },
      partDelta(1, "SECOND"),
      terminal,
    ],
    [
      created(),
      partDelta(0, "FIRST"),
      partDone(0, "FIRST"),
      partDelta(1, "SECOND"),
      partDelta(0, "late"),
      terminal,
    ],
    [
      created(),
      partDelta(0, "FIRST"),
      partDone(0, "FIRST"),
      partDelta(1, "SECOND"),
      {
        type: "response.output_item.done",
        output_index: 1,
        item: item("FIRST"),
      },
      terminal,
    ],
    [created(), partDelta(0, "FIRST"), partDone(0, "wrong"), terminal],
    [
      created(),
      {
        type: "response.content_part.done",
        ...coordinates,
        content_index: 0,
        part: { type: "output_text" },
      },
      partDelta(0, "FIRST"),
      terminal,
    ],
    [
      created(),
      partDelta(0, "FIRST"),
      partDone(0, "FIRST"),
      {
        type: "response.output_item.done",
        output_index: 1,
        item: item("FIRST"),
      },
      partDelta(1, "SECOND"),
      terminal,
    ],
    [created(), partDelta(0, "FIRST"), partDone(0, "FIRST"), terminal],
  ])
    await assert.rejects(decode(events));
});

test("Responses preserves finite UTF8/output/byte bounds and cancels interrupted readers", async () => {
  const bytes = new TextEncoder().encode(wire(full()));
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of bytes) controller.enqueue(new Uint8Array([b]));
      controller.close();
    },
  });
  assert.deepEqual(
    await collect(
      readResponse(chunked, new AbortController().signal, {
        expectedModel: model,
      }),
    ),
    await decode(full()),
  );
  await assert.rejects(decode(full(), { maxOutputCharacters: 1 }));
  await assert.rejects(decode(full(), { maxStreamBytes: 1 }));
  for (const maxOutputCharacters of [0, -1, 1.5, Infinity, 128001])
    await assert.rejects(decode(full(), { maxOutputCharacters }));
  await assert.rejects(
    collect(
      readResponse(
        new Response(new Uint8Array([0xc3, 0x28])).body!,
        new AbortController().signal,
        { expectedModel: model },
      ),
    ),
  );
  const abort = new AbortController();
  let cancelled = false;
  const pending = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire([created()])));
    },
    cancel() {
      cancelled = true;
    },
  });
  const consuming = collect(
    readResponse(pending, abort.signal, { expectedModel: model }),
  );
  abort.abort();
  await assert.rejects(consuming);
  assert.equal(cancelled, true);
});

test("Responses charge lookup accepts only its exact API plus unchanged receipt/model/provider/reference decimal proof", async () => {
  const data = {
    id: generation,
    session_id: reference,
    model,
    provider: "openai",
    api: "responses",
    source: "api",
    has_web_search: false,
    total_cost: 0.123456789,
  };
  const p = provider(async (url, init) => {
    assert.equal(url, "https://routerai.ru/api/v1/generation?id=" + generation);
    assert.equal(init?.method, "GET");
    return Response.json({ data });
  });
  const charge = await p.readCharge(
    generation,
    reference,
    new AbortController().signal,
  );
  assert.equal(charge.costRub, "0.123456789");
  assert.equal(charge.amountMicros, 123456);
  assert.equal(charge.upstream, "openai");
  for (const patch of [
    { api: "chat/completions" },
    { model: "other/model" },
    { provider: "azure" },
    { session_id: "other" },
    { source: "chat" },
    { has_web_search: true },
    { total_cost: "0.1" },
  ])
    await assert.rejects(
      provider(async () =>
        Response.json({ data: { ...data, ...patch } }),
      ).readCharge(generation, reference, new AbortController().signal),
    );
});

test("Responses protocol is explicit and cannot switch through a mutable options object or HTTP failures", async () => {
  const options = {
    protocol: "responses" as const,
    upstream: "openai",
    fetch: async (url: Parameters<typeof fetch>[0]) => {
      assert.equal(url, "https://routerai.ru/api/v1/responses");
      return sse(full());
    },
  };
  const p = new RouterAIProvider("synthetic", model, options);
  Object.assign(options, { protocol: undefined });
  assert.equal((await run(p)).at(-1)?.type, "complete");
  assert.throws(() => provider(async () => sse(full()), { protocol: "chat" }));
  for (const status of [402, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      run(
        provider(async () => {
          calls++;
          return new Response("private upstream body", { status });
        }),
      ),
      status === 402
        ? RouterAIInsufficientFundsError
        : /^Error: RouterAI generation failed or was interrupted$/,
    );
    assert.equal(calls, 1);
  }
});

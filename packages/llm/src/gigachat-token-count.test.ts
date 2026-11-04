import assert from "node:assert/strict";
import test from "node:test";
import { GigaChatProvider } from "./gigachat.js";
import {
  gigaAuthUrl,
  gigaChatUrl,
  gigaTokenCountUrl,
  type GigaPost,
} from "./gigachat-http.js";
import type { ModelMessage } from "./provider.js";

const credentials = Buffer.from("count-test:synthetic-not-live").toString(
  "base64",
);
const now = 1800000000000;
const model = "GigaChat-3-Ultra";
const failure = { message: "GigaChat token count failed or was interrupted" };
const signal = () => new AbortController().signal;
const auth = (value = "synthetic-count-access") =>
  Response.json({ access_token: value, expires_at: now + 1800000 });
const counted = (counts: number[]) =>
  Response.json(counts.map((tokens) => ({ object: "tokens", tokens })));
const make = (post: GigaPost, timeoutMs = 60000) =>
  new GigaChatProvider(credentials, model, {
    scope: "GIGACHAT_API_PERS",
    now: () => now,
    post,
    timeoutMs,
  });

test("explicit text-count preflight uses fixed model, OAuth and one aligned batch without generation", async () => {
  const question = "К".repeat(99_999) + "🏠";
  const messages: ModelMessage[] = [
    { role: "user", content: question },
    { role: "assistant", content: "Ранее сохранённый ответ" },
  ];
  let authCalls = 0,
    countCalls = 0;
  const provider = make(async (url, init) => {
    init.signal.throwIfAborted();
    if (url === gigaAuthUrl) {
      authCalls++;
      assert.equal(init.headers.Authorization, `Basic ${credentials}`);
      return auth();
    }
    countCalls++;
    assert.equal(url, gigaTokenCountUrl);
    assert.deepEqual(init.headers, {
      Authorization: "Bearer synthetic-count-access",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    assert.deepEqual(JSON.parse(init.body), {
      model,
      input: ["Инструкции", question, "Ранее сохранённый ответ"],
    });
    // This is synthetic counter data, not a statement about real token ratios.
    return counted([5, 50_000, 7]);
  });
  assert.equal(authCalls, 0);
  assert.equal(countCalls, 0);
  for (let index = 0; index < 2; index++)
    assert.deepEqual(
      await provider.countInputTokens("Инструкции", messages, signal()),
      { instructions: 5, messages: [50_000, 7] },
    );
  assert.equal(authCalls, 1);
  assert.equal(countCalls, 2);
});

test("token count snapshots private strings before waiting for OAuth", async () => {
  let release!: (value: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const messages: ModelMessage[] = [
    { role: "user", content: "Исходный вопрос" },
  ];
  const provider = make(async (url, init) => {
    if (url === gigaAuthUrl) return waiting;
    assert.equal(url, gigaTokenCountUrl);
    assert.deepEqual(JSON.parse(init.body).input, ["", "Исходный вопрос"]);
    return counted([0, 4]);
  });
  const pending = provider.countInputTokens("", messages, signal());
  messages[0]!.content = "Текст другого аккаунта";
  messages.push({ role: "assistant", content: "Поздний текст" });
  release(auth());
  assert.deepEqual(await pending, { instructions: 0, messages: [4] });
});

test("CityGo token count bounds include JSON escaping, exact 2 MiB and 256 input strings", async () => {
  let authCalls = 0,
    countCalls = 0;
  const provider = make(async (url, init) => {
    if (url === gigaAuthUrl) {
      authCalls++;
      return auth();
    }
    assert.equal(url, gigaTokenCountUrl);
    countCalls++;
    const input = JSON.parse(init.body).input as string[];
    assert.ok(Buffer.byteLength(init.body) <= 2 * 1024 * 1024);
    return counted(input.map((value) => (value ? 1 : 0)));
  });
  const overhead = Buffer.byteLength(JSON.stringify({ model, input: [""] }));
  const exact = "x".repeat(2 * 1024 * 1024 - overhead);
  assert.deepEqual(await provider.countInputTokens(exact, [], signal()), {
    instructions: 1,
    messages: [],
  });
  await assert.rejects(
    provider.countInputTokens(exact + "x", [], signal()),
    failure,
  );
  await assert.rejects(
    provider.countInputTokens("\u0000".repeat(400_000), [], signal()),
    failure,
  );
  const messages = Array.from({ length: 255 }, () => ({
    role: "user" as const,
    content: "x",
  }));
  assert.equal(
    (await provider.countInputTokens("", messages, signal())).messages.length,
    255,
  );
  await assert.rejects(
    provider.countInputTokens("", [...messages, messages[0]!], signal()),
    failure,
  );
  assert.equal(authCalls, 1);
  assert.equal(countCalls, 2);
});

test("invalid token count input is rejected before OAuth or any data leaves the process", async () => {
  let calls = 0;
  const provider = make(async () => {
    calls++;
    throw new Error("Unexpected transport");
  });
  for (const messages of [
    null,
    [{ role: "system", content: "private input" }],
    [{ role: "user", content: null }],
    [null],
    [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 1) }],
  ])
    await assert.rejects(
      provider.countInputTokens("", messages as ModelMessage[], signal()),
      failure,
    );
  assert.equal(calls, 0);
});

for (const status of [302, 401, 403, 422, 429, 500, 503])
  test(`token count HTTP ${status} is cancelled and never retried or treated as a generation`, async () => {
    let authCalls = 0,
      countCalls = 0,
      cancelled = 0;
    const provider = make(async (url) => {
      if (url === gigaAuthUrl) {
        authCalls++;
        return auth();
      }
      assert.equal(url, gigaTokenCountUrl);
      countCalls++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status },
      );
    });
    await assert.rejects(
      provider.countInputTokens(
        "",
        [{ role: "user", content: "Вопрос" }],
        signal(),
      ),
      failure,
    );
    assert.equal(authCalls, 1);
    assert.equal(countCalls, 1);
    assert.equal(cancelled, 1);
  });

test("a counter 401 invalidates auth only for the next explicit action, not an automatic retry", async () => {
  let authCalls = 0,
    countCalls = 0;
  const provider = make(async (url, init) => {
    if (url === gigaAuthUrl) return auth("token-" + ++authCalls);
    assert.equal(url, gigaTokenCountUrl);
    assert.equal(init.headers.Authorization, "Bearer token-" + authCalls);
    return ++countCalls === 1
      ? new Response("private upstream error", { status: 401 })
      : counted([0, 1]);
  });
  const messages: ModelMessage[] = [{ role: "user", content: "Вопрос" }];
  await assert.rejects(
    provider.countInputTokens("", messages, signal()),
    failure,
  );
  assert.equal(authCalls, 1);
  assert.equal(countCalls, 1);
  assert.deepEqual(await provider.countInputTokens("", messages, signal()), {
    instructions: 0,
    messages: [1],
  });
  assert.equal(authCalls, 2);
  assert.equal(countCalls, 2);
});

const invalidResults: unknown[] = [
  null,
  {},
  { data: [{ tokens: 1 }, { tokens: 2 }] },
  [],
  [{ tokens: 1 }],
  [{ tokens: 1 }, { tokens: 2 }, { tokens: 3 }],
  [null, { tokens: 2 }],
  [[1], { tokens: 2 }],
  [{ tokens: "1" }, { tokens: 2 }],
  [{ tokens: -1 }, { tokens: 2 }],
  [{ tokens: 1.5 }, { tokens: 2 }],
  [{ tokens: 0 }, { tokens: 2 }],
  [{ tokens: 1 }, { tokens: Number.MAX_SAFE_INTEGER + 1 }],
  [{ tokens: 1 }, { tokens: Number.MAX_SAFE_INTEGER }],
  [{ tokens: 1, object: "not-tokens" }, { tokens: 2 }],
  [{ tokens: 1, characters: "1" }, { tokens: 2 }],
  [{ tokens: 1, characters: -1 }, { tokens: 2 }],
];
test("counter validates aligned safe integer text counts without exposing upstream errors or text", async () => {
  for (const result of invalidResults) {
    let countCalls = 0;
    const provider = make(async (url) => {
      if (url === gigaAuthUrl) return auth();
      assert.equal(url, gigaTokenCountUrl);
      countCalls++;
      return Response.json(result);
    });
    await assert.rejects(
      provider.countInputTokens(
        "Инструкции",
        [{ role: "user", content: "Вопрос" }],
        signal(),
      ),
      failure,
    );
    assert.equal(countCalls, 1);
  }
});

test("counter bounds actual streamed response bytes and rejects malformed JSON/UTF-8/type", async () => {
  for (const response of [
    new Response(null),
    new Response("[]"),
    new Response("private malformed upstream JSON", {
      headers: { "content-type": "application/json" },
    }),
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
    new Response(" ".repeat(64 * 1024 + 1), {
      headers: { "content-type": "application/json", "content-length": "1" },
    }),
    new Response("[]", {
      headers: {
        "content-type": "application/json",
        "content-length": "65537",
      },
    }),
    new Response("[]", {
      headers: {
        "content-type": "application/json",
        "content-length": "invalid",
      },
    }),
  ]) {
    const provider = make(async (url) =>
      url === gigaAuthUrl ? auth() : response,
    );
    await assert.rejects(provider.countInputTokens("", [], signal()), failure);
  }
});

test("pre-aborted counter sends nothing; stalled response is cancelled on abort and timeout", async () => {
  let calls = 0;
  const unused = make(async () => {
    calls++;
    throw new Error("Unexpected transport");
  });
  await assert.rejects(
    unused.countInputTokens("", [], AbortSignal.abort()),
    failure,
  );
  assert.equal(calls, 0);
  for (const mode of ["abort", "timeout"] as const) {
    const controller = new AbortController();
    let cancelled = 0,
      countCalls = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = make(
      async (url) => {
        if (url === gigaAuthUrl) return auth();
        assert.equal(url, gigaTokenCountUrl);
        countCalls++;
        started();
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
      mode === "timeout" ? 20 : 60000,
    );
    const pending = assert.rejects(
      provider.countInputTokens("", [], controller.signal),
      failure,
    );
    await ready;
    // AbortSignal.timeout is unref'd; a bounded ordinary timer keeps this
    // isolated fake transport test alive until its deadline has been observed.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      if (mode === "abort") controller.abort();
      await pending;
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(cancelled, 1);
    assert.equal(countCalls, 1);
  }
});

test("a successful counter never invokes chat; cached OAuth remains usable for a later explicit generation", async () => {
  let authCalls = 0,
    countCalls = 0,
    generations = 0,
    guards = 0,
    generationIds = 0;
  const provider = make(async (url) => {
    if (url === gigaAuthUrl) return auth("token-" + ++authCalls);
    if (url === gigaTokenCountUrl) {
      countCalls++;
      return counted([0, 1]);
    }
    assert.equal(url, gigaChatUrl);
    generations++;
    return new Response(
      `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: "Ответ" } }] })}\n\n` +
        `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const messages: ModelMessage[] = [{ role: "user", content: "Вопрос" }];
  await provider.countInputTokens("", messages, signal());
  assert.equal(generations, 0);
  for await (const event of provider.stream("", messages, signal(), {
    beforeRetry: async () => {
      guards++;
    },
    billing: {
      reference: "synthetic-reference",
      onGeneration: async () => {
        generationIds++;
      },
    },
  }))
    assert.ok(event);
  assert.equal(authCalls, 1);
  assert.equal(countCalls, 1);
  assert.equal(generations, 1);
  assert.equal(guards, 0);
  assert.equal(generationIds, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { ApiError, createClient, createSessionGuard } from "./index.js";

// Local fake fetch only. No API server, credentials, provider or payment calls.
const headers = { [CONTRACT_VERSION_HEADER]: "1" };
const threadId = "9007199254740993";
const message = (id: string) => ({
  id,
  role: "user",
  content: "Сохранённый вопрос",
  agentKey: "support",
  status: "complete",
  favorite: false,
});
const page = () => ({
  userId: "1",
  threadId,
  messages: [message("9007199254740993"), message("9007199254740994")],
  nextCursor: null,
});
const invalidResponse = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("conversation history client sends exact int64 GET paths once with existing cookie/native authentication", async () => {
  for (const native of [false, true]) {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const client = createClient("http://synthetic", {
      native,
      token: () => "synthetic-session",
      fetch: async (url, init) => {
        calls.push({ path: String(url), init });
        return Response.json(page(), { headers });
      },
    });
    assert.deepEqual(await client.conversationMessages(threadId), page());
    assert.deepEqual(
      await client.conversationMessages(threadId, "9223372036854775807"),
      page(),
    );
    assert.deepEqual(
      calls.map(({ path }) => path),
      [
        "http://synthetic/v1/conversations/" + threadId + "/messages",
        "http://synthetic/v1/conversations/" +
          threadId +
          "/messages?before=9223372036854775807",
      ],
    );
    for (const { init } of calls) {
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.credentials, "include");
      const sentHeaders = new Headers(init?.headers);
      assert.equal(sentHeaders.get(CONTRACT_VERSION_HEADER), "1");
      assert.equal(
        sentHeaders.get("authorization"),
        "Bearer synthetic-session",
      );
      assert.equal(
        sentHeaders.get("x-citygo-client"),
        native ? "native" : null,
      );
      assert.ok(init?.signal instanceof AbortSignal);
    }
  }
});

test("malformed history IDs/cursors fail before fetch and credential access, without Number normalization", async () => {
  let effects = 0;
  const client = createClient("http://synthetic", {
    token: () => {
      effects++;
      return "synthetic-session";
    },
    fetch: async () => {
      effects++;
      return Response.json(page(), { headers });
    },
  });
  for (const value of [
    "",
    "0",
    "01",
    "-1",
    "1.5",
    "1e3",
    "1\n",
    " 1",
    "1 ",
    "9223372036854775808",
    "../admin",
    "1?userId=2",
    "١",
    1,
    null,
  ]) {
    await assert.rejects(client.conversationMessages(value as string));
    await assert.rejects(
      client.conversationMessages(threadId, value as string),
    );
  }
  assert.equal(effects, 0);
});

test("history page response is strict, thread-bound and ascending/unique below the requested boundary", async () => {
  let reply: unknown;
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json(reply, { headers });
    },
  });
  const base = page();
  for (const malformed of [
    {},
    null,
    [],
    { ...base, userId: undefined },
    { ...base, userId: "0" },
    { ...base, userId: "1\n" },
    { ...base, threadId: "9007199254740994" },
    { ...base, threadId: "1\n" },
    { ...base, unknown: "synthetic-private-upstream" },
    {
      ...base,
      messages: [message("9007199254740994"), message("9007199254740993")],
    },
    {
      ...base,
      messages: [message("9007199254740993"), message("9007199254740993")],
    },
    { ...base, messages: [message("not-an-id"), message("2")] },
    { ...base, messages: [message("1"), message("9223372036854775808")] },
    { ...base, messages: [message("9007199254740995")] },
    { ...base, messages: [message("9007199254740996")] },
    { ...base, messages: [{ ...message("1"), role: "tool" }] },
    { ...base, messages: [{ ...message("1"), status: "pending" }] },
    { ...base, messages: [message("1\n")] },
    {
      ...base,
      messages: Array.from({ length: 101 }, (_, index) =>
        message(String(index + 1)),
      ),
    },
    { ...base, messages: [], nextCursor: "1" },
    { ...base, nextCursor: "9007199254740992" },
    { ...base, nextCursor: 1 },
    { ...base, nextCursor: "1\n" },
  ]) {
    reply = malformed;
    const before = calls;
    await assert.rejects(
      client.conversationMessages(threadId, "9007199254740995"),
      invalidResponse,
    );
    assert.equal(calls, before + 1, "invalid pages are never retried");
  }
});

test("a byte-bounded short history page retains its exact older cursor in Web and native", async () => {
  const reply = { ...page(), nextCursor: "9007199254740993" };
  for (const native of [false, true]) {
    let calls = 0;
    const client = createClient("http://synthetic", {
      native,
      fetch: async () => {
        calls++;
        return Response.json(reply, { headers });
      },
    });
    assert.deepEqual(await client.conversationMessages(threadId), reply);
    assert.equal(calls, 1);
  }
});

test("full history pages use first/oldest ID as cursor and preserve complete/interrupted metadata", async () => {
  const messages = Array.from({ length: 100 }, (_, index) =>
    message(String(9_007_199_254_740_993n + BigInt(index))),
  );
  const response = {
    userId: "1",
    threadId,
    messages,
    nextCursor: messages[0]!.id,
  };
  let reply: unknown = response;
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(reply, { headers }),
  });
  assert.deepEqual(
    await client.conversationMessages(threadId, "9223372036854775807"),
    response,
  );
  reply = { ...response, nextCursor: null };
  assert.deepEqual(await client.conversationMessages(threadId), reply);
  for (const nextCursor of [
    messages.at(-1)!.id,
    "9007199254740992",
    "9007199254740993\n",
  ]) {
    reply = { ...response, nextCursor };
    await assert.rejects(
      client.conversationMessages(threadId),
      invalidResponse,
    );
  }
  const metadata = {
    ...message("9007199254740994"),
    role: "assistant",
    status: "interrupted",
    favorite: true,
    generation: null,
    failureCode: "AI_CREDIT_EXHAUSTED",
  };
  reply = { userId: "1", threadId, messages: [metadata], nextCursor: null };
  assert.deepEqual(await client.conversationMessages(threadId), reply);
  reply = { userId: "1", threadId, messages: [], nextCursor: null };
  assert.deepEqual(await client.conversationMessages(threadId), reply);
});

test("a current-session history401 invalidates authorization once and is never retried", async () => {
  let calls = 0,
    invalidated = 0;
  const client = createClient("http://synthetic", {
    onUnauthorized: () => invalidated++,
    fetch: async () => {
      calls++;
      return Response.json(
        { error: "Войдите в аккаунт" },
        { status: 401, headers },
      );
    },
  });
  await assert.rejects(
    client.conversationMessages(threadId),
    (error) =>
      error instanceof ApiError &&
      error.code === "http" &&
      error.status === 401,
  );
  assert.equal(calls, 1);
  assert.equal(invalidated, 1);
});

test("a cancelled/changed owner cannot publish late history or invalidate the replacement account", async () => {
  for (const status of [200, 401]) {
    const session = createSessionGuard(),
      pending = deferred<Response>(),
      entered = deferred<void>();
    let published = 0,
      invalidated = 0,
      calls = 0;
    const client = createClient("http://synthetic", {
      signal: () => session.capture().signal,
      onUnauthorized: () => invalidated++,
      fetch: async () => {
        calls++;
        entered.resolve();
        return pending.promise;
      },
    });
    const result = client
      .conversationMessages(threadId, "9223372036854775807")
      .then(() => {
        published++;
      });
    await entered.promise;
    session.reset("replacement-account");
    await assert.rejects(
      result,
      (error) => error instanceof ApiError && error.code === "aborted",
    );
    pending.resolve(
      Response.json(status === 200 ? page() : { error: "Expired" }, {
        status,
        headers,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(published, 0);
    assert.equal(invalidated, 0);
    assert.equal(calls, 1);
  }
});

test("pre-aborted history loads and timed-out GETs never dispatch a retry", async (t) => {
  const cancelled = new AbortController();
  cancelled.abort();
  let effects = 0;
  const preCancelled = createClient("http://synthetic", {
    signal: () => cancelled.signal,
    token: () => {
      effects++;
      return null;
    },
    fetch: async () => {
      effects++;
      return Response.json(page(), { headers });
    },
  });
  await assert.rejects(
    preCancelled.conversationMessages(threadId),
    (error) => error instanceof ApiError && error.code === "aborted",
  );
  assert.equal(effects, 0);
  let calls = 0;
  const pending = deferred<Response>();
  const client = createClient("http://synthetic", {
    limits: { requestTimeoutMs: 25 },
    fetch: async () => {
      calls++;
      return pending.promise;
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rejected = assert.rejects(
      client.conversationMessages(threadId),
      (error) => error instanceof ApiError && error.code === "timeout",
    );
    t.mock.timers.tick(25);
    await rejected;
    pending.resolve(Response.json(page(), { headers }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
  } finally {
    t.mock.timers.reset();
  }
});

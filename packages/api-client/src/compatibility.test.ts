import test from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION_HEADER, errorMetadata } from "@citygo/contracts";
import { createClient, ApiError } from "./index.js";

test("Web and native declare v1 for commands and streams; old servers remain readable", async () => {
  for (const native of [false, true]) {
    const requests: RequestInit[] = [];
    const client = createClient("http://synthetic", {
      native,
      fetch: async (url, init) => {
        requests.push(init!);
        return String(url).endsWith("/messages")
          ? new Response('data: {"type":"done","messageId":"1"}\n\n', {
              headers: { "Content-Type": "text/event-stream" },
            })
          : Response.json({ awarded: 0, future: true });
      },
    });
    assert.deepEqual(await client.complete("1"), { awarded: 0 });
    await client.stream("1", "test", "request", () => {});
    for (const init of requests) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get(CONTRACT_VERSION_HEADER), "1");
      assert.equal(headers.get("X-CityGo-Client"), native ? "native" : null);
    }
  }
});
test("unknown response versions cancel JSON/SSE without callback, retry or false success", async () => {
  for (const streaming of [false, true]) {
    let calls = 0,
      events = 0,
      cancelled = 0;
    const client = createClient("http://synthetic", {
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          {
            headers: {
              [CONTRACT_VERSION_HEADER]: "2",
              "Content-Type": streaming
                ? "text/event-stream"
                : "application/json",
            },
          },
        );
      },
    });
    await assert.rejects(
      streaming
        ? client.stream("1", "test", "request", () => events++)
        : client.complete("1"),
      (e: unknown) =>
        e instanceof ApiError &&
        e.serverCode === "CONTRACT_VERSION_UNSUPPORTED",
    );
    assert.equal(calls, 1);
    assert.equal(events, 0);
    assert.equal(cancelled, 1);
  }
});
test("an incompatible 401 still invalidates protected sessions but not a rejected login", async () => {
  let invalidated = 0;
  const client = createClient("http://synthetic", {
    onUnauthorized: () => invalidated++,
    fetch: async () =>
      Response.json(
        { error: "Expired" },
        { status: 401, headers: { [CONTRACT_VERSION_HEADER]: "2" } },
      ),
  });
  await assert.rejects(
    client.dashboard(),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(invalidated, 1);
  await assert.rejects(
    client.auth("login", "synthetic@example.test", "synthetic-password"),
  );
  assert.equal(invalidated, 1);
});

test("HTTP errors retain legacy text, server code, request correlation and revision without retry", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json(
        {
          error: "Обновите данные",
          ...errorMetadata("REVISION_CONFLICT", "server-request", 4),
        },
        { status: 409 },
      );
    },
  });
  await assert.rejects(client.complete("1"), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.code, "http");
    assert.equal(e.serverCode, "REVISION_CONFLICT");
    assert.equal(e.requestId, "server-request");
    assert.equal(e.currentVersion, 4);
    assert.equal(e.retryable, false);
    assert.equal(e.message, "Обновите данные");
    return true;
  });
  assert.equal(calls, 1);
  const unknown = createClient("http://synthetic", {
    fetch: async () =>
      Response.json(
        { error: "Проверьте состояние", code: "NEW_CODE" },
        { status: 409 },
      ),
  });
  await assert.rejects(
    unknown.complete("1"),
    (e: unknown) =>
      e instanceof ApiError &&
      e.serverCode === "NEW_CODE" &&
      e.message === "Проверьте состояние",
  );
});
test("SSE metadata survives error delivery and cannot become done", async () => {
  const event = {
    type: "error",
    message: "Бюджет исчерпан",
    ...errorMetadata("AI_BUDGET_EXHAUSTED", "server-request"),
  };
  const events: unknown[] = [];
  const client = createClient("http://synthetic", {
    fetch: async () =>
      new Response(
        `data: ${JSON.stringify(event)}\n\ndata: {"type":"done","messageId":"1"}\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            [CONTRACT_VERSION_HEADER]: "1",
          },
        },
      ),
  });
  await assert.rejects(
    client.stream("1", "test", "request", (e) => events.push(e)),
    (e: unknown) =>
      e instanceof ApiError &&
      e.code === "stream_error" &&
      e.serverCode === "AI_BUDGET_EXHAUSTED" &&
      e.requestId === "server-request",
  );
  assert.deepEqual(events, [event]);
});

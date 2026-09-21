import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "./index.js";
test("admin routing client sends the displayed revision and policy without auto-retry", async () => {
  const original = globalThis.fetch;
  const requests: { method: string; body: unknown }[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push({
      method: options?.method ?? "GET",
      body: options?.body ? JSON.parse(String(options.body)) : null,
    });
    return options?.method === "POST"
      ? Response.json({ error: "Настройка изменена" }, { status: 409 })
      : Response.json({
          current: { provider: "disabled", policyId: null, revision: 1 },
          effectiveProvider: "unconfigured",
          environmentDisabled: false,
          automaticFallback: false,
          options: [],
          audit: [],
        });
  };
  try {
    const client = createClient("http://test");
    await client.aiControl();
    const input = {
      provider: "disabled" as const,
      policyId: null,
      expectedRevision: 1,
    };
    await assert.rejects(client.setAiRouting(input), /Настройка изменена/);
    assert.deepEqual(requests, [
      { method: "GET", body: null },
      { method: "POST", body: input },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("client sends explicit consent actions and the viewed policy ID with chat", async () => {
  const original = globalThis.fetch;
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = async (url, options) => {
    requests.push({
      path: String(url),
      body: JSON.parse(String(options?.body)),
    });
    return String(url).endsWith("/messages")
      ? new Response('data: {"type":"done","messageId":"1"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        })
      : Response.json({ ok: true });
  };
  try {
    const client = createClient("http://test");
    const policyId = "a".repeat(64);
    await client.aiConsent({ action: "granted", policyId });
    await client.stream("1", "test", "uuid", () => {}, undefined, policyId);
    await client.aiConsent({ action: "revoked" });
    assert.deepEqual(requests, [
      {
        path: "http://test/v1/ai/consent",
        body: { action: "granted", policyId },
      },
      {
        path: "http://test/v1/threads/1/messages",
        body: { text: "test", requestId: "uuid", policyId },
      },
      { path: "http://test/v1/ai/consent", body: { action: "revoked" } },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("SSE decoder preserves split UTF-8, multiple events and terminal state", async () => {
  const original = globalThis.fetch;
  const bytes = new TextEncoder().encode(
    'data: {"type":"delta","text":"Жильё"}\n\ndata: {"type":"done","messageId":"1"}\n\n',
  );
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  try {
    const events: unknown[] = [];
    await createClient("http://test").stream("1", "test", "uuid", (event) =>
      events.push(event),
    );
    assert.deepEqual(events, [
      { type: "delta", text: "Жильё" },
      { type: "done", messageId: "1" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("SSE connection closing without done is a visible error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('data: {"type":"delta","text":"partial"}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  try {
    await assert.rejects(
      createClient("http://test").stream("1", "test", "uuid", () => {}),
      /Соединение прервано/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

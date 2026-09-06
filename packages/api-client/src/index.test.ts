import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "./index.js";
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
    new Response('data: {"type":"delta","text":"partial"}\n\n');
  try {
    await assert.rejects(
      createClient("http://test").stream("1", "test", "uuid", () => {}),
      /Соединение прервано/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createClient, ApiError } from "./index.js";

test("Web and native send a complete 100000-character Unicode question once", async () => {
  const text = "😀".repeat(100000);
  for (const native of [false, true]) {
    const requests: unknown[] = [];
    const client = createClient("http://synthetic", {
      native,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response('data: {"type":"done","messageId":"1"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    await client.stream("1", text, "synthetic", () => {});
    assert.deepEqual(requests, [{ text, requestId: "synthetic" }]);
  }
});

test("invalid or oversized chat fails before fetch, token access, retries or stream callbacks", async () => {
  let effects = 0;
  const client = createClient("http://synthetic", {
    token: () => {
      effects++;
      return "synthetic-session";
    },
    fetch: async () => {
      effects++;
      throw new Error("must-not-send");
    },
  });
  for (const text of [
    "a".repeat(100001),
    "😀".repeat(100001),
    "a\ud800",
    "\udfffz",
    "a\0b",
    " \n ",
  ])
    await assert.rejects(
      client.stream("1", text, "synthetic", () => {
        effects++;
      }),
      (error) => error instanceof ApiError && error.status === 400,
    );
  assert.equal(effects, 0);
});

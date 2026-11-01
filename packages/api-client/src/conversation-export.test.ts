import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { createClient, ApiError } from "./index.js";
const id = "9007199254740993";
const snapshot = () => ({
  version: 1,
  userId: "1",
  generatedAt: "2026-11-01T10:00:00Z",
  thread: { id, agentKey: "support", assistantKey: "support", closed: true },
  messages: [
    {
      id: "9007199254740994",
      role: "assistant",
      content: "Полная старая история 😀",
      agentKey: "support",
      status: "complete",
      failureCode: null,
      createdAt: "2026-11-01T09:00:00Z",
    },
  ],
});
const headers = { [CONTRACT_VERSION_HEADER]: "1" };
test("export uses one exact authenticated GET without query, request body, provider or retry", async () => {
  for (const native of [false, true]) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createClient("http://synthetic", {
      native,
      token: () => "synthetic-session",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(snapshot(), { headers });
      },
    });
    assert.deepEqual(await client.exportConversation(id), snapshot());
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      "http://synthetic/v1/conversations/" + id + "/export",
    );
    assert.equal(calls[0]!.init?.method, "GET");
    assert.equal(calls[0]!.init?.body, undefined);
    assert.equal(calls[0]!.init?.credentials, "include");
    assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
    const sent = new Headers(calls[0]!.init?.headers);
    assert.equal(sent.get("authorization"), "Bearer synthetic-session");
    assert.equal(sent.get("x-citygo-client"), native ? "native" : null);
  }
});
test("invalid export IDs fail before reading credentials or invoking fetch", async () => {
  let effects = 0;
  const client = createClient("http://synthetic", {
    token: () => {
      effects++;
      return "synthetic";
    },
    fetch: async () => {
      effects++;
      return Response.json(snapshot(), { headers });
    },
  });
  for (const invalid of [
    "0",
    "01",
    "1\n",
    "1?userId=2",
    "../admin",
    "9223372036854775808",
    null,
    1,
  ])
    await assert.rejects(client.exportConversation(invalid as string));
  assert.equal(effects, 0);
});
test("wrong-thread, malformed, unsorted or private-extra exports are rejected without raw upstream details", async () => {
  let body: unknown;
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(body, { headers }),
  });
  const v = snapshot();
  for (const invalid of [
    null,
    {},
    { ...v, thread: { ...v.thread, id: "2" } },
    { ...v, messages: [v.messages[0], v.messages[0]] },
    { ...v, messages: [{ ...v.messages[0], content: "\ud800" }] },
    { ...v, extra: "PRIVATE" },
  ]) {
    body = invalid;
    await assert.rejects(
      client.exportConversation(id),
      (error) =>
        error instanceof ApiError &&
        error.code === "invalid_response" &&
        !error.message.includes("PRIVATE"),
    );
  }
});
test("aborted session or HTTP413 produces no retry or usable partial snapshot", async () => {
  const controller = new AbortController();
  let reads = 0;
  const client = createClient("http://synthetic", {
    signal: () => controller.signal,
    fetch: async () => {
      reads++;
      return Response.json(
        { error: "PRIVATE", code: "INTERNAL_ERROR" },
        { status: 413, headers },
      );
    },
  });
  await assert.rejects(
    client.exportConversation(id),
    (error) => error instanceof ApiError && error.status === 413,
  );
  assert.equal(reads, 1);
  controller.abort();
  await assert.rejects(
    client.exportConversation(id),
    (error) => error instanceof ApiError && error.code === "aborted",
  );
  assert.equal(reads, 1);
});

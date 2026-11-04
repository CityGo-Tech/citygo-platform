import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";

const headers = { [CONTRACT_VERSION_HEADER]: "1" };
const threadId = "9007199254740993";
const target = "9223372036854775807";
const message = (id: string) => ({
  id,
  role: "user",
  content: "Сохранённое",
  agentKey: "support",
  status: "complete",
  favorite: true,
});
const page = () => ({
  userId: "1",
  threadId,
  messages: [message("9007199254740994"), message(target)],
  nextCursor: null,
});

test("source context preserves exact int64 IDs in one authenticated GET and no body", async () => {
  for (const native of [false, true]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = createClient("http://synthetic", {
      native,
      token: () => "synthetic-session",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(page(), { headers });
      },
    });
    assert.deepEqual(
      await client.conversationMessageContext(threadId, target),
      page(),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      `http://synthetic/v1/conversations/${threadId}/messages/${target}/context`,
    );
    assert.equal(calls[0]!.init?.method, "GET");
    assert.equal(calls[0]!.init?.body, undefined);
    const sent = new Headers(calls[0]!.init?.headers);
    assert.equal(sent.get("authorization"), "Bearer synthetic-session");
    assert.equal(sent.get("x-citygo-client"), native ? "native" : null);
  }
});

test("source context malformed IDs fail before fetch or access to authentication", async () => {
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
  for (const bad of [
    "",
    "0",
    "01",
    "1\n",
    " 1",
    "9223372036854775808",
    "1/context",
    "../admin",
    1,
    null,
    undefined,
  ]) {
    await assert.rejects(
      client.conversationMessageContext(bad as string, target),
    );
    await assert.rejects(
      client.conversationMessageContext(threadId, bad as string),
    );
  }
  assert.equal(effects, 0);
});

test("source context rejects missing/different target, foreign thread, invalid ordering and dishonest cursors without retry", async () => {
  let reply: unknown;
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json(reply, { headers });
    },
  });
  const base = page();
  for (const invalid of [
    { ...base, messages: [] },
    { ...base, messages: [message("1")] },
    { ...base, threadId: "9007199254740994" },
    { ...base, messages: [message(target), message("9007199254740994")] },
    { ...base, messages: [message(target), message(target)] },
    { ...base, nextCursor: base.messages.at(-1)!.id },
    { ...base, messages: [message("1\n"), message(target)] },
    { ...base, messages: [{ ...message(target), role: "tool" }] },
  ]) {
    reply = invalid;
    const before = calls;
    await assert.rejects(
      client.conversationMessageContext(threadId, target),
      (error) => error instanceof ApiError && error.code === "invalid_response",
    );
    assert.equal(calls, before + 1);
  }
});

test("source context preserves a full bounded window and truthful older cursor", async () => {
  const messages = Array.from({ length: 100 }, (_, i) =>
    message((9223372036854775708n + BigInt(i)).toString()),
  );
  const reply = {
    userId: "1",
    threadId,
    messages,
    nextCursor: messages[0]!.id,
  };
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(reply, { headers }),
  });
  assert.deepEqual(
    await client.conversationMessageContext(threadId, target),
    reply,
  );
});

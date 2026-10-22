import assert from "node:assert/strict";
import test from "node:test";
import {
  agentKeys,
  CONTRACT_VERSION_HEADER,
  type AgentKey,
} from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";

const headers = { [CONTRACT_VERSION_HEADER]: "1" };
const invalidResponse = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";

test("conversation client starts the explicit assistant once and keeps the empty legacy request", async () => {
  const calls: { path: string; method: string | undefined; body: unknown }[] =
    [];
  let wrongReply: unknown;
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ path: String(url), method: init?.method, body });
      return Response.json(
        wrongReply ??
          (body.agentKey === undefined
            ? { id: "1", agentKey: "support" }
            : {
                id: "2",
                agentKey: body.agentKey,
                assistantKey: body.agentKey,
                closed: false,
              }),
        { headers },
      );
    },
  });
  assert.deepEqual(await client.startConversation(), {
    id: "1",
    agentKey: "support",
  });
  assert.deepEqual(calls[0], {
    path: "http://synthetic/v1/conversations/start",
    method: "POST",
    body: {},
  });
  for (const agentKey of agentKeys) {
    assert.deepEqual(await client.startConversation(agentKey), {
      id: "2",
      agentKey,
      assistantKey: agentKey,
      closed: false,
    });
    assert.deepEqual(calls.at(-1)!.body, { agentKey });
  }
  for (const reply of [
    { id: "2", agentKey: "support", assistantKey: "support", closed: false },
    { id: "2", agentKey: "housing" },
    { id: "2", agentKey: "housing", assistantKey: "housing", closed: true },
  ]) {
    wrongReply = reply;
    const before = calls.length;
    await assert.rejects(client.startConversation("housing"), invalidResponse);
    assert.equal(
      calls.length,
      before + 1,
      "a failed response is never retried",
    );
  }
  const before = calls.length;
  await assert.rejects(client.startConversation("bubble" as AgentKey));
  await assert.rejects(client.startConversation(null as unknown as AgentKey));
  assert.equal(
    calls.length,
    before,
    "unknown assistants never reach transport",
  );
});

const summary = (id: string) => ({
  id,
  agentKey: "housing",
  assistantKey: "housing",
  closed: false,
  updatedAt: "2030-01-01T12:00:00.000Z",
  preview: "Сохранённый вопрос",
});

test("conversation pages keep int64 cursors exact and reject wrong page identity without retry", async () => {
  const calls: string[] = [];
  let reply: unknown = {
    userId: "1",
    conversations: [summary("9007199254740993"), summary("9007199254740992")],
    nextCursor: "9007199254740992",
  };
  const client = createClient("http://synthetic", {
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(reply, { headers });
    },
  });
  assert.deepEqual(await client.conversations("9223372036854775807"), reply);
  assert.equal(
    calls[0],
    "http://synthetic/v1/conversations?before=9223372036854775807",
  );
  reply = { userId: "1", conversations: [], nextCursor: null };
  assert.deepEqual(await client.conversations(), reply);
  assert.equal(calls.at(-1), "http://synthetic/v1/conversations");
  for (const malformed of [
    { conversations: [summary("8"), summary("9")], nextCursor: null },
    { conversations: [summary("8"), summary("8")], nextCursor: null },
    { conversations: [summary("10")], nextCursor: null },
    { conversations: [summary("8")], nextCursor: "7" },
    { conversations: [], nextCursor: "8" },
    {
      conversations: [{ ...summary("8"), preview: "x".repeat(241) }],
      nextCursor: null,
    },
    {
      conversations: [{ ...summary("8"), agentKey: "support" }],
      nextCursor: null,
    },
  ]) {
    reply = { userId: "1", ...malformed };
    const before = calls.length;
    await assert.rejects(client.conversations("10"), invalidResponse);
    assert.equal(calls.length, before + 1);
  }
  for (const owner of [
    undefined,
    "0",
    "foreign-owner",
    "9223372036854775808",
  ]) {
    reply = {
      ...(owner === undefined ? {} : { userId: owner }),
      conversations: [],
      nextCursor: null,
    };
    await assert.rejects(client.conversations(), invalidResponse);
  }
  const before = calls.length;
  for (const cursor of [
    "",
    "0",
    "01",
    "-1",
    "1.5",
    "9223372036854775808",
    "../admin",
  ])
    await assert.rejects(client.conversations(cursor));
  assert.equal(calls.length, before);
});

test("conversation detail validates thread identity and complete metadata, preserving both message roles", async () => {
  const messages = [
    {
      id: "9007199254740993",
      role: "user",
      content: "Мой вопрос",
      agentKey: "housing",
      status: "complete",
      favorite: true,
    },
    {
      id: "9007199254740994",
      role: "assistant",
      content: "Сохранённый ответ",
      agentKey: "housing",
      status: "complete",
      favorite: false,
    },
  ];
  let reply: unknown = {
    userId: "1",
    thread: {
      id: "3",
      agentKey: "housing",
      assistantKey: "housing",
      closed: false,
      messages,
    },
  };
  const calls: string[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(reply, { headers });
    },
  });
  assert.deepEqual(await client.conversation("3"), reply);
  assert.equal(calls[0], "http://synthetic/v1/conversations/3");
  for (const thread of [
    {
      id: "4",
      agentKey: "housing",
      assistantKey: "housing",
      closed: false,
      messages,
    },
    { id: "3", agentKey: "housing", messages },
    {
      id: "3",
      agentKey: "housing",
      assistantKey: "support",
      closed: false,
      messages,
    },
  ]) {
    reply = { userId: "1", thread };
    await assert.rejects(client.conversation("3"), invalidResponse);
  }
  reply = {
    thread: {
      id: "3",
      agentKey: "housing",
      assistantKey: "housing",
      closed: false,
      messages,
    },
  };
  await assert.rejects(client.conversation("3"), invalidResponse);
  const before = calls.length;
  await assert.rejects(client.conversation("3?userId=2"));
  assert.equal(calls.length, before);
});

test("a cancelled conversation read cannot invalidate the replacement session on a late 401", async () => {
  const controller = new AbortController();
  let deliver!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let invalidated = 0;
  const client = createClient("http://synthetic", {
    signal: () => controller.signal,
    onUnauthorized: () => invalidated++,
    fetch: async () => {
      entered();
      // Deliberately ignore abort, like a transport delivering late headers.
      return new Promise<Response>((resolve) => {
        deliver = resolve;
      });
    },
  });
  const pending = client.conversation("3");
  await started;
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof ApiError && error.code === "aborted",
  );
  deliver(Response.json({ error: "Expired" }, { status: 401, headers }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(invalidated, 0);
});

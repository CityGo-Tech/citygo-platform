import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";

test("favorite client sends explicit state once and validates message identity/state", async () => {
  const calls: { path: string; body: unknown }[] = [];
  let reply: unknown = { messageId: "3", saved: true };
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({
        path: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(reply, {
        headers: { [CONTRACT_VERSION_HEADER]: "1" },
      });
    },
  });
  assert.deepEqual(await client.setMessageFavorite("3", true), reply);
  assert.deepEqual(calls, [
    { path: "http://synthetic/v1/messages/3/favorite", body: { saved: true } },
  ]);
  reply = { messageId: "4", saved: true };
  await assert.rejects(
    client.setMessageFavorite("3", true),
    (e) => e instanceof ApiError && e.code === "invalid_response",
  );
  reply = { messageId: "3", saved: false };
  await assert.rejects(
    client.setMessageFavorite("3", true),
    (e) => e instanceof ApiError && e.code === "invalid_response",
  );
  const before = calls.length;
  await assert.rejects(client.setMessageFavorite("../admin", true));
  assert.equal(calls.length, before);
});

test("favorite pages validate schema and use exact keyset IDs without retries", async () => {
  const calls: string[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(
        { userId: "1", messages: [], nextBefore: null },
        { headers: { [CONTRACT_VERSION_HEADER]: "1" } },
      );
    },
  });
  assert.deepEqual(await client.favoriteMessages("9007199254740993"), {
    userId: "1",
    messages: [],
    nextBefore: null,
  });
  assert.deepEqual(calls, [
    "http://synthetic/v1/messages/favorites?before=9007199254740993",
  ]);
  await assert.rejects(client.favoriteMessages(""));
  assert.equal(calls.length, 1);
});

test("favorite client encodes literal search and validates filters before a single read", async () => {
  const calls: string[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(
        { userId: "1", messages: [], nextBefore: null },
        { headers: { [CONTRACT_VERSION_HEADER]: "1" } },
      );
    },
  });
  await client.favoriteMessages("9007199254740993", {
    search: "50%_\\path & Москва",
    assistantKey: "support",
    role: "assistant",
  });
  const url = new URL(calls[0]!);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    before: "9007199254740993",
    search: "50%_\\path & Москва",
    assistantKey: "support",
    role: "assistant",
  });
  await assert.rejects(client.favoriteMessages(undefined, { search: " " }));
  await assert.rejects(
    client.favoriteMessages(undefined, { role: "system" } as never),
  );
  assert.equal(calls.length, 1);
});

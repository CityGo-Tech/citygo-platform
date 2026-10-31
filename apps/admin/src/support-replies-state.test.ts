import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { SupportReply } from "@citygo/contracts";
import {
  createSupportRepliesResource,
  type SupportRepliesState,
} from "./support-replies-state.js";
test("uncertain human reply retains exact draft and operation until explicit retry, and revocation clears them", async () => {
  const states: SupportRepliesState[] = [],
    calls: unknown[] = [],
    signal = new AbortController();
  let denied = 0;
  const r = createSupportRepliesResource({
    viewerId: "1",
    requestId: "2",
    signal: signal.signal,
    admin: true,
    operationId: () => "41111111-1111-4111-8111-111111111111",
    publish: (s) => states.push(s),
    onAccessDenied: () => denied++,
    list: async () => {
      throw new ApiError(404, "not found", "http");
    },
    send: async (input) => {
      calls.push(input);
      if (calls.length === 1) throw new Error("network lost");
      throw new ApiError(403, "role revoked", "http");
    },
  });
  r.edit("Сохраните список нужных районов.");
  await r.send(7);
  assert.equal(calls.length, 1);
  assert.equal(states.at(-1)!.draft, "Сохраните список нужных районов.");
  assert.equal(states.at(-1)!.pending!.expectedRevision, 7);
  r.edit("Другой ответ");
  await r.load();
  assert.equal(states.at(-1)!.draft, "Сохраните список нужных районов.");
  assert.equal(states.at(-1)!.pending!.expectedRevision, 7);
  await r.send(8);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(denied, 1);
  assert.equal(states.at(-1)!.draft, "");
  assert.equal(states.at(-1)!.pending, null);
});

test("invalid human reply draft never invokes transport or leaves a pending command", async () => {
  const states: SupportRepliesState[] = [];
  const r = createSupportRepliesResource({
    viewerId: "1",
    requestId: "2",
    signal: new AbortController().signal,
    admin: true,
    operationId: () => "41111111-1111-4111-8111-111111111111",
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    list: async () => ({
      actorId: "1",
      requestId: "2",
      replies: [],
      nextBefore: null,
    }),
    send: async () => {
      assert.fail("invalid draft sent");
    },
  });
  r.edit("  ");
  await r.send(1);
  assert.equal(states.at(-1)!.pending, null);
  assert.equal(states.at(-1)!.busy, false);
  assert.match(states.at(-1)!.error, /Проверьте/);
  r.dispose();
});

test("acknowledging an old human reply resets its keyset range before a fresh read and subsequent pagination", async () => {
  const states: SupportRepliesState[] = [],
    operations: unknown[] = [];
  const operationId = "41111111-1111-4111-8111-111111111111";
  const reply = (id: number): SupportReply => ({
    id: String(id),
    requestId: "2",
    operationId,
    body: "Сохранённый ответ",
    createdAt: "2026-10-31T10:00:00Z",
  });
  const first = Array.from({ length: 20 }, (_, i) => reply(40 - i));
  let pageCalls = 0;
  const r = createSupportRepliesResource({
    viewerId: "1",
    requestId: "2",
    admin: true,
    signal: new AbortController().signal,
    operationId: () => operationId,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    list: async (before) => {
      pageCalls++;
      return {
        actorId: "1",
        requestId: "2",
        replies: before ? [reply(10)] : first,
        nextBefore: before ? null : "21",
      };
    },
    send: async (input) => {
      operations.push(input);
      if (operations.length === 1) throw new Error("network lost");
      return {
        actorId: "1",
        request: {
          id: "2",
          operationId,
          body: "Нужна помощь с выбором района.",
          status: "open",
          revision: 50,
          createdAt: "2026-10-31T09:00:00Z",
          updatedAt: "2026-10-31T10:00:00Z",
          closedAt: null,
          owner: { userId: "3", email: null, username: null },
        },
        reply: reply(10),
      };
    },
  });
  r.edit("Сохранённый ответ");
  await r.send(1);
  await r.load();
  await r.send(50);
  assert.deepEqual(operations[1], operations[0]);
  assert.equal(
    pageCalls,
    2,
    "acknowledgement reads first page without another POST",
  );
  assert.deepEqual(
    states.at(-1)!.replies.map((v) => v.id),
    first.map((v) => v.id),
  );
  await r.load(states.at(-1)!.nextBefore!);
  assert.equal(states.at(-1)!.error, "");
  assert.equal(states.at(-1)!.replies.length, 21);
  assert.equal(states.at(-1)!.replies.at(-1)!.id, "10");
  r.dispose();
});
test("reply reads ignore late rows after abort and cannot expose a foreign owner", async () => {
  const signal = new AbortController(),
    states: SupportRepliesState[] = [];
  let resolve!: (r: {
    userId: string;
    requestId: string;
    replies: [];
    nextBefore: null;
  }) => void;
  const r = createSupportRepliesResource({
    viewerId: "1",
    requestId: "2",
    signal: signal.signal,
    admin: false,
    operationId: () => "unused",
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    list: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const loading = r.load();
  signal.abort();
  resolve({ userId: "9", requestId: "2", replies: [], nextBefore: null });
  await loading;
  assert.equal(states.at(-1)!.closed, true);
  assert.deepEqual(states.at(-1)!.replies, []);
});

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

test("explicit seen cursor acknowledges only a fully rendered prefix, keeps fresh replies unread and closes on denial", async () => {
  const states: SupportRepliesState[] = [],
    calls: string[] = [];
  const signal = new AbortController();
  let phase = 0,
    denied = 0;
  const reply = (id: string): SupportReply => ({
    id,
    requestId: "2",
    operationId: "41111111-1111-4111-8111-111111111111",
    body: "Ответ",
    createdAt: "2026-10-31T10:00:00Z",
  });
  const r = createSupportRepliesResource({
    viewerId: "1",
    requestId: "2",
    signal: signal.signal,
    admin: false,
    operationId: () => "unused",
    publish: (s) => states.push(s),
    onAccessDenied: () => denied++,
    list: async (before) => ({
      userId: "1",
      requestId: "2",
      replies: before
        ? [reply("1")]
        : phase
          ? [reply("4"), reply("3"), reply("2"), reply("1")]
          : [reply("3"), reply("2")],
      nextBefore: !before && !phase ? "2" : null,
    }),
    markRead: async (through) => {
      calls.push(through);
      if (phase === 2) throw new ApiError(403, "blocked", "http");
      return {
        userId: "1",
        requestId: "2",
        throughReplyId: through,
        unreadReplies: 1,
      };
    },
  });
  await r.acknowledgeDisplayed();
  assert.equal(calls.length, 0);
  await r.load();
  await r.acknowledgeDisplayed();
  assert.equal(calls.length, 0);
  await r.load("2");
  assert.equal(calls.length, 0);
  await r.acknowledgeDisplayed();
  assert.deepEqual(calls, ["3"]);
  assert.equal(states.at(-1)!.readThrough, "3");
  await r.acknowledgeDisplayed();
  assert.deepEqual(calls, ["3"]);
  phase = 1;
  await r.load();
  assert.equal(states.at(-1)!.readThrough, "3");
  assert.equal(calls.length, 1);
  phase = 2;
  await r.acknowledgeDisplayed();
  assert.equal(denied, 1);
  assert.equal(states.at(-1)!.closed, true);
  assert.deepEqual(states.at(-1)!.replies, []);
  r.dispose();
});
test("late read acknowledgement after session cancellation neither restores data nor refreshes another account", async () => {
  const states: SupportRepliesState[] = [],
    signal = new AbortController();
  let release!: () => void,
    notices = 0;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const r = createSupportRepliesResource({
    viewerId: "1",
    requestId: "2",
    signal: signal.signal,
    admin: false,
    operationId: () => "unused",
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    onRead: () => notices++,
    list: async () => ({
      userId: "1",
      requestId: "2",
      replies: [
        {
          id: "3",
          requestId: "2",
          operationId: "41111111-1111-4111-8111-111111111111",
          body: "Ответ",
          createdAt: "2026-10-31T10:00:00Z",
        },
      ],
      nextBefore: null,
    }),
    markRead: async () => {
      await pending;
      return {
        userId: "1",
        requestId: "2",
        throughReplyId: "3",
        unreadReplies: 0,
      };
    },
  });
  await r.load();
  const request = r.acknowledgeDisplayed();
  signal.abort();
  release();
  await request;
  assert.equal(notices, 0);
  assert.equal(states.at(-1)!.closed, true);
  assert.deepEqual(states.at(-1)!.replies, []);
  assert.equal(states.at(-1)!.readThrough, null);
  r.dispose();
});

import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { Message } from "@citygo/contracts";
import {
  createConversationHistoryResource,
  projectConversationHistory,
  type ConversationHistoryState,
} from "./conversation-history-state";

const rows = (first: number, count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(first + index),
    role: (first + index) % 2 ? "user" : "assistant",
    agentKey: "support",
    content: `Сохранённое сообщение ${first + index}`,
    status: "complete",
    favorite: false,
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(total = 350, maxPages = 10) {
  const owner = new AbortController(),
    states: ConversationHistoryState[] = [],
    calls: string[] = [];
  let denied = 0;
  const all = rows(1, total);
  const source = {
    load: async (before: string): Promise<unknown> => {
      calls.push(before);
      const earlier = all.filter(
        (message) => BigInt(message.id) < BigInt(before),
      );
      const messages = earlier.slice(-100);
      return {
        userId: "10",
        threadId: "20",
        messages,
        nextCursor: earlier.length > 100 ? messages[0]!.id : null,
      };
    },
  };
  const resource = createConversationHistoryResource({
    userId: "10",
    threadId: "20",
    initialMessages: all.slice(-100),
    sessionSignal: owner.signal,
    load: (before) => source.load(before),
    publish: (state) => states.push(state),
    onAccessDenied: () => {
      denied++;
    },
    maxPages,
  });
  return {
    resource,
    source,
    owner,
    calls,
    states,
    all,
    denied: () => denied,
    last: () => resource.snapshot(),
  };
}

test("three explicit older pages reach the beginning in strict order with no duplicates or automatic reads", async () => {
  const s = setup();
  assert.deepEqual(s.calls, []);
  assert.equal(s.last().nextCursor, "251");
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  assert.deepEqual(s.calls, ["251", "151", "51"]);
  assert.deepEqual(s.last().messages, s.all);
  assert.equal(s.last().nextCursor, null);
  s.resource.dispose();
});

test("exactly100 messages permits one empty ending page; short/legacy IDs never guess a cursor", async () => {
  const s = setup(100);
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  assert.deepEqual(s.calls, ["1"]);
  assert.equal(s.last().messages.length, 100);
  assert.equal(s.last().nextCursor, null);
  s.resource.dispose();
  for (const initialMessages of [
    rows(1, 99),
    [{ ...rows(1, 1)[0]!, id: "legacy-id" }],
  ]) {
    let calls = 0;
    const value = createConversationHistoryResource({
      userId: "10",
      threadId: "20",
      initialMessages,
      sessionSignal: new AbortController().signal,
      load: async () => {
        calls++;
        return {};
      },
      publish: () => {},
    });
    await value.loadOlder();
    assert.equal(calls, 0);
    value.dispose();
  }
});

test("explicit byte-bounded short pages remain reachable and return-to-latest preserves their cursor", async () => {
  const calls: string[] = [],
    initialMessages = rows(101, 3);
  const value = createConversationHistoryResource({
    userId: "10",
    threadId: "20",
    initialMessages,
    initialNextCursor: "101",
    sessionSignal: new AbortController().signal,
    load: async (before) => {
      calls.push(before);
      return {
        userId: "10",
        threadId: "20",
        messages: rows(98, 3),
        nextCursor: "98",
      };
    },
    publish: () => {},
  });
  assert.deepEqual(calls, []);
  assert.equal(value.snapshot().nextCursor, "101");
  await value.loadOlder();
  assert.deepEqual(calls, ["101"]);
  assert.deepEqual(value.snapshot().messages, rows(98, 6));
  assert.equal(value.snapshot().nextCursor, "98");
  value.returnToLatest();
  assert.deepEqual(value.snapshot().messages, initialMessages);
  assert.equal(value.snapshot().nextCursor, "101");
  value.dispose();
});

test("an explicit short latest snapshot cannot join two ranges across a gap", () => {
  const s = setup();
  s.resource.acceptLatest(rows(1001, 2), "1001");
  assert.deepEqual(s.last().messages, rows(1001, 2));
  assert.match(s.last().notice, /Появились новые сообщения/);
  assert.equal(s.last().nextCursor, "1001");
  s.resource.returnToLatest();
  assert.equal(s.last().nextCursor, "1001");
  s.resource.acceptLatest(rows(2001, 2), null);
  assert.deepEqual(s.last().messages, rows(2001, 2));
  assert.equal(s.last().nextCursor, null);
  s.resource.dispose();
});

test("focus/stream/balance refresh preserves an older prefix and updates only confirmed favorites before latest refresh", async () => {
  const s = setup();
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  s.resource.patchFavorite({ messageId: "51", saved: true });
  const latest = rows(253, 100);
  latest[99]!.content = "ПОСЛЕДНИЙ ВОПРОС";
  s.resource.acceptLatest(latest);
  assert.equal(s.last().messages[0]!.id, "51");
  assert.equal(s.last().messages.length, 302);
  assert.equal(s.last().messages[0]!.favorite, true);
  assert.equal(s.last().messages.at(-1)!.content, "ПОСЛЕДНИЙ ВОПРОС");
  assert.equal(s.last().nextCursor, "51");
  assert.equal(
    new Set(s.last().messages.map((message) => message.id)).size,
    302,
  );
  s.resource.dispose();
});

test("a bounded window keeps moving to the beginning, detaches without a gap, and returns to fresh latest data", async () => {
  const s = setup(1250, 2);
  await s.resource.loadOlder();
  assert.equal(s.last().detached, false);
  await s.resource.loadOlder();
  assert.equal(s.last().detached, true);
  assert.equal(s.last().messages.length, 200);
  assert.equal(s.last().messages.at(-1)!.id, "1150");
  s.resource.acceptLatest(rows(1153, 100));
  assert.equal(s.last().messages.at(-1)!.id, "1150");
  while (s.last().nextCursor) await s.resource.loadOlder();
  assert.equal(s.last().messages[0]!.id, "1");
  assert.equal(s.last().messages.at(-1)!.id, "200");
  assert.ok(s.calls.length > 10);
  assert.ok(s.states.every((state) => state.messages.length <= 200));
  s.resource.returnToLatest();
  assert.equal(s.last().detached, false);
  assert.equal(s.last().messages.at(-1)!.id, "1252");
  assert.equal(s.last().nextCursor, "1153");
  s.resource.dispose();
});

test("non-overlapping newer latest data resets honestly instead of joining disjoint ranges", async () => {
  const s = setup();
  await s.resource.loadOlder();
  s.resource.acceptLatest(rows(1001, 100));
  assert.deepEqual(
    s.last().messages.map((message) => message.id),
    rows(1001, 100).map((message) => message.id),
  );
  assert.match(s.last().notice, /Появились новые сообщения/);
  assert.equal(s.last().nextCursor, "1001");
  assert.equal(s.last().detached, false);
  s.resource.dispose();
});

test("foreign owner/thread, cursor mismatch, overlapping IDs, descending pages and extra rows fail closed", async () => {
  for (const change of [
    { userId: "11" },
    { threadId: "21" },
    { nextCursor: "99" },
    { messages: rows(251, 100), nextCursor: "251" },
    { messages: rows(151, 100).reverse(), nextCursor: "250" },
    { messages: rows(150, 101), nextCursor: "150" },
  ]) {
    const s = setup();
    s.source.load = async () => ({
      userId: "10",
      threadId: "20",
      messages: rows(151, 100),
      nextCursor: "151",
      ...change,
    });
    await s.resource.loadOlder();
    assert.equal(s.last().phase, "error");
    assert.deepEqual(s.last().messages, s.all.slice(-100));
    assert.equal(s.last().nextCursor, "251");
    s.resource.dispose();
  }
});

test("a failed read retains authorized rows and cursor; retry is deliberate and does not auto-fetch", async () => {
  const s = setup(),
    original = s.source.load;
  s.source.load = async () => {
    throw new Error("SYNTHETIC_PRIVATE_PROVIDER_TEXT");
  };
  await s.resource.loadOlder();
  assert.equal(s.last().phase, "error");
  assert.equal(s.last().error.includes("SYNTHETIC"), false);
  assert.deepEqual(s.calls, []);
  s.source.load = original;
  await s.resource.loadOlder();
  assert.equal(s.last().phase, "ready");
  assert.equal(s.last().messages.length, 200);
  assert.deepEqual(s.calls, ["251"]);
  s.resource.dispose();
});

test("duplicate clicks share one read and return-to-latest cancels an obsolete page", async () => {
  const s = setup(),
    delayed = deferred<unknown>();
  s.source.load = async (before) => {
    s.calls.push(before);
    return delayed.promise;
  };
  const first = s.resource.loadOlder();
  await s.resource.loadOlder();
  assert.deepEqual(s.calls, ["251"]);
  s.resource.returnToLatest();
  delayed.resolve({
    userId: "10",
    threadId: "20",
    messages: rows(151, 100),
    nextCursor: "151",
  });
  await first;
  assert.equal(s.last().messages.length, 100);
  assert.equal(s.last().phase, "ready");
  s.resource.dispose();
});

test("logout or disposal prevents late history/401 from restoring data or revoking a newer owner", async () => {
  for (const abort of [true, false]) {
    const s = setup(),
      delayed = deferred<unknown>();
    s.source.load = async () => delayed.promise;
    const read = s.resource.loadOlder();
    if (abort) s.owner.abort();
    else s.resource.dispose();
    const count = s.states.length;
    delayed.reject(new ApiError(401, "synthetic old session"));
    await read;
    assert.equal(s.denied(), 0);
    assert.equal(s.states.length, count);
    assert.equal(s.last().messages.length, 0);
    s.resource.dispose();
  }
});

test("only a current401 closes data and requests the existing login flow", async () => {
  const s = setup();
  s.source.load = async () => {
    throw new ApiError(401, "synthetic current session");
  };
  await s.resource.loadOlder();
  assert.equal(s.denied(), 1);
  assert.equal(s.last().phase, "closed");
  assert.equal(s.last().messages.length, 0);
  s.resource.dispose();
});

test("a fresh non-overlapping latest snapshot supersedes a delayed older read", async () => {
  const s = setup(),
    delayed = deferred<unknown>();
  s.source.load = async () => delayed.promise;
  const read = s.resource.loadOlder();
  s.resource.acceptLatest(rows(1001, 100));
  delayed.resolve({
    userId: "10",
    threadId: "20",
    messages: rows(151, 100),
    nextCursor: "151",
  });
  await read;
  assert.equal(s.last().messages[0]!.id, "1001");
  assert.equal(s.last().phase, "ready");
  s.resource.dispose();
});

test("render projection never appends newest rows to a detached historical window", () => {
  const state: ConversationHistoryState = {
    phase: "ready",
    messages: rows(1, 100),
    nextCursor: null,
    detached: true,
    error: "",
    notice: "",
    loadedPages: 0,
  };
  assert.equal(projectConversationHistory(state, rows(1001, 100)), state);
});

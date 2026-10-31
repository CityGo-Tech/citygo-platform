import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import {
  createMessageSearchResource,
  type MessageSearchState,
} from "./conversation-message-search-state";
const hits = (first: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    messageId: String(first - i),
    role: "user",
    agentKey: "support",
    status: "complete",
    snippet: "Москва " + (first - i),
  }));
const page = (
  search = "Москва",
  first = 50,
  count = 20,
  next: string | null = "31",
) => ({
  userId: "10",
  threadId: "20",
  search,
  matches: hits(first, count),
  nextCursor: next,
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { resolve, promise };
}
function setup(
  load: (
    search: string,
    before: string | undefined,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  const owner = new AbortController(),
    states: MessageSearchState[] = [];
  let denied = 0;
  const resource = createMessageSearchResource({
    userId: "10",
    threadId: "20",
    sessionSignal: owner.signal,
    load,
    publish: (s) => states.push(s),
    onAccessDenied: () => denied++,
  });
  return { owner, states, resource, denied: () => denied };
}
test("in-thread search loads old matches with bounded keysets, repeated more clicks never duplicate a request", async () => {
  const calls: (string | undefined)[] = [];
  const second = deferred<unknown>();
  const f = setup(async (_q, before) => {
    calls.push(before);
    return before ? second.promise : page();
  });
  await f.resource.search("  Москва  ");
  const a = f.resource.more(),
    b = f.resource.more();
  assert.deepEqual(calls, [undefined, "31"]);
  second.resolve(page("Москва", 30, 3, null));
  await Promise.all([a, b]);
  assert.equal(f.resource.snapshot().matches.length, 23);
  assert.equal(f.resource.snapshot().nextCursor, null);
  f.resource.dispose();
});
test("query replacement, invalid search and abort discard late responses even if transport ignores cancellation", async () => {
  const old = deferred<unknown>();
  const f = setup(async (q) =>
    q === "Москва" ? old.promise : page(q, 5, 1, null),
  );
  const pending = f.resource.search("Москва");
  await f.resource.search("Казань");
  old.resolve(page());
  await pending;
  assert.equal(f.resource.snapshot().search, "Казань");
  assert.equal(f.resource.snapshot().matches[0]!.messageId, "5");
  const late = deferred<unknown>();
  const g = setup(() => late.promise);
  const waiting = g.resource.search("Москва");
  await g.resource.search(" ");
  late.resolve(page());
  await waiting;
  assert.equal(g.resource.snapshot().phase, "error");
  assert.equal(g.resource.snapshot().matches.length, 0);
  const h = setup(() => Promise.resolve(page()));
  await h.resource.search("Москва");
  h.owner.abort();
  assert.equal(h.resource.snapshot().phase, "closed");
  assert.deepEqual(h.resource.snapshot().matches, []);
  f.resource.dispose();
  g.resource.dispose();
  h.resource.dispose();
});
test("cross-owner/thread, revoked session and disposal never publish private results", async () => {
  for (const invalid of [
    { ...page(), userId: "11" },
    { ...page(), threadId: "21" },
  ]) {
    const f = setup(async () => invalid);
    await f.resource.search("Москва");
    assert.equal(f.resource.snapshot().phase, "closed");
    assert.equal(f.denied(), 1);
    assert.deepEqual(f.resource.snapshot().matches, []);
  }
  for (const code of [401, 403]) {
    const f = setup(async () => {
      throw new ApiError(code, "synthetic");
    });
    await f.resource.search("Москва");
    assert.equal(f.denied(), 1);
    assert.equal(f.resource.snapshot().phase, "closed");
  }
  const late = deferred<unknown>();
  const f = setup(() => late.promise);
  const pending = f.resource.search("Москва");
  f.resource.dispose();
  const count = f.states.length;
  late.resolve(page());
  await pending;
  assert.equal(f.states.length, count);
});
test("a failed or forged search page preserves confirmed results and an explicit retry can continue", async () => {
  let fail = true;
  const f = setup(async (q, b) => {
    if (b && fail) throw new Error("PRIVATE_UPSTREAM");
    return b ? page(q, 30, 1, null) : page(q);
  });
  await f.resource.search("Москва");
  await f.resource.more();
  assert.equal(f.resource.snapshot().matches.length, 20);
  assert.equal(f.resource.snapshot().phase, "error");
  assert(!f.resource.snapshot().error.includes("PRIVATE"));
  fail = false;
  await f.resource.more();
  assert.equal(f.resource.snapshot().matches.length, 21);
  f.resource.dispose();
  const g = setup(async () => page("other"));
  await g.resource.search("Москва");
  assert.equal(g.resource.snapshot().phase, "error");
  assert.equal(g.resource.snapshot().matches.length, 0);
  g.resource.dispose();
});

test("message search keeps at most 200 visible matches while continuing older cursor pages", async () => {
  const f = setup(async (q, b) => {
    const first = b ? Number(b) - 1 : 500;
    return page(q, first, 20, String(first - 19));
  });
  await f.resource.search("Москва");
  for (let i = 0; i < 10; i++) await f.resource.more();
  const state = f.resource.snapshot();
  assert.equal(state.matches.length, 200);
  assert.equal(state.matches[0]!.messageId, "480");
  assert.equal(state.matches.at(-1)!.messageId, "281");
  assert.equal(state.nextCursor, "281");
  assert.equal(state.trimmed, true);
  f.resource.dispose();
});

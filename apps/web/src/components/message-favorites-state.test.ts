import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { FavoriteMessage, FavoriteMessagesPage } from "@citygo/contracts";
import {
  createFavoriteMessagesResource,
  type FavoriteMessagesState,
} from "./message-favorites-state";
const message = (
  id: string,
  role: "user" | "assistant" = "assistant",
): FavoriteMessage => ({
  id,
  threadId: "1",
  content: "saved",
  agentKey: "support",
  role,
  status: "complete",
});
const page = (
  messages: FavoriteMessage[],
  nextBefore: string | null = null,
  userId = "1",
): FavoriteMessagesPage => ({ userId, messages, nextBefore });
function setup(
  read: (
    before: string | undefined,
    filters: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<FavoriteMessagesPage>,
) {
  const session = new AbortController();
  const states: FavoriteMessagesState[] = [];
  let denied = 0;
  const removed: string[] = [];
  const value = createFavoriteMessagesResource({
    userId: "1",
    sessionSignal: session.signal,
    client: {
      page: read,
      remove: async (id) => {
        removed.push(id);
      },
    },
    publish: (state) => states.push(state),
    onAccessDenied: () => denied++,
  });
  return { value, session, states, removed, denied: () => denied };
}

test("favorite filters reset cursor, cancel requests and reject stale replies even when transport ignores abort", async () => {
  let release!: (page: FavoriteMessagesPage) => void;
  let oldSignal!: AbortSignal;
  const calls: unknown[] = [];
  const s = setup(async (before, filters, signal) => {
    calls.push([before, filters]);
    if (calls.length === 1) {
      oldSignal = signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    }
    return page([message("9", "user")]);
  });
  const old = s.value.load();
  await s.value.filter({ search: "literal %_", role: "user" });
  assert.ok(oldSignal.aborted);
  release(page([message("100")]));
  await old;
  assert.deepEqual(
    s.value.snapshot().messages.map((m) => m.id),
    ["9"],
  );
  assert.deepEqual(calls, [
    [undefined, {}],
    [undefined, { search: "literal %_", role: "user" }],
  ]);
  await s.value.filter({});
  assert.equal(s.value.snapshot().nextBefore, null);
  s.value.dispose();
});

test("favorite byte-capped pages below20 retain exact bigint cursor and filters without duplicates", async () => {
  const calls: unknown[] = [];
  const s = setup(async (before, filters) => {
    calls.push([before, filters]);
    return before
      ? page([message("9007199254740991")])
      : page(
          [message("9007199254740993"), message("9007199254740992")],
          "9007199254740992",
        );
  });
  await s.value.filter({ assistantKey: "support" });
  await s.value.load("9007199254740992");
  assert.deepEqual(
    s.value.snapshot().messages.map((m) => m.id),
    ["9007199254740993", "9007199254740992", "9007199254740991"],
  );
  assert.deepEqual(calls[1], ["9007199254740992", { assistantKey: "support" }]);
  await s.value.remove("9007199254740992");
  assert.deepEqual(s.removed, ["9007199254740992"]);
  s.value.dispose();
});

test("favorite malformed order, repeated cursor and filter mismatches never publish as ready", async () => {
  for (const result of [
    page([message("9"), message("9")]),
    page([message("8"), message("9")]),
    page([message("9")], "8"),
    page([], "9"),
    page([message("9", "user")]),
  ]) {
    const s = setup(async () => result);
    await s.value.filter({ role: "assistant" });
    assert.equal(s.value.snapshot().phase, "error");
    assert.deepEqual(s.value.snapshot().messages, []);
    s.value.dispose();
  }
});

test("favorite owner mismatch or access denial clears content and prevents further reads", async () => {
  for (const cause of [null, 401, 403]) {
    let calls = 0;
    const s = setup(async () => {
      calls++;
      if (cause) throw new ApiError(cause, "denied");
      return page([message("9")], null, "2");
    });
    await s.value.load();
    assert.equal(s.value.snapshot().phase, "closed");
    assert.equal(s.denied(), 1);
    assert.deepEqual(s.value.snapshot().messages, []);
    await s.value.load();
    assert.equal(calls, 1);
    s.value.dispose();
  }
});

test("favorite session abort clears every page and ignores late private text", async () => {
  let release!: (value: FavoriteMessagesPage) => void;
  const s = setup(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = s.value.load();
  s.session.abort();
  release(page([message("9")]));
  await pending;
  assert.equal(s.value.snapshot().phase, "closed");
  assert.deepEqual(s.value.snapshot().messages, []);
  assert.equal(s.denied(), 0);
  s.value.dispose();
});

test("invalid favorite filter is shown locally without sending a request", async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return page([]);
  });
  await s.value.filter({ search: "\0" });
  assert.equal(calls, 0);
  assert.match(s.value.snapshot().error, /160/);
  s.value.dispose();
});

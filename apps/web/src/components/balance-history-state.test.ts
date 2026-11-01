import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type {
  BalanceHistoryFilter,
  BalanceHistoryPage,
} from "@citygo/contracts";
import {
  createBalanceHistoryResource,
  type BalanceHistoryState,
} from "./balance-history-state";
const page = (filter: BalanceHistoryFilter = "all"): BalanceHistoryPage => ({
  userId: "1",
  filter,
  entries: [
    {
      id: "credit:100",
      kind: filter === "gift" ? "gift" : "spend",
      direction: filter === "gift" ? "credit" : "debit",
      amountMicros: 2_170_001,
      createdAt: "2026-11-01T00:00:00.000001Z",
    },
  ],
  nextCursor: null,
});
test("a late old filter or disposed session cannot publish history or clear a new request", async () => {
  const states: BalanceHistoryState[] = [];
  let release: (p: BalanceHistoryPage) => void = () => {};
  const resource = createBalanceHistoryResource({
    userId: "1",
    signal: new AbortController().signal,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      balanceHistory: async (q) =>
        q.filter === "all"
          ? new Promise((r) => {
              release = r;
            })
          : page(q.filter),
    },
  });
  const old = resource.refresh();
  await resource.filter("gift");
  release(page());
  await old;
  assert.equal(states.at(-1)?.filter, "gift");
  assert.equal(states.at(-1)?.entries[0]!.kind, "gift");
  const active = resource.refresh();
  const count = states.length;
  resource.dispose();
  await active;
  assert.equal(states.length, count);
});
test("owner mismatch/access denied purges history; temporary error preserves retry while stale cursor resets it", async () => {
  for (const status of [200, 401, 403, 409, 503]) {
    const states: BalanceHistoryState[] = [];
    let mode = false,
      denied = 0;
    const resource = createBalanceHistoryResource({
      userId: "1",
      signal: new AbortController().signal,
      publish: (s) => states.push(s),
      onAccessDenied: () => {
        denied++;
      },
      client: {
        balanceHistory: async () => {
          if (mode) {
            if (status === 200) return { ...page(), userId: "2" };
            throw new ApiError(status, "PRIVATE_PROVIDER_ERROR", "http");
          }
          return { ...page(), nextCursor: "cursor" };
        },
      },
    });
    await resource.refresh();
    mode = true;
    await resource.loadMore();
    assert.equal(denied, [200, 401, 403].includes(status) ? 1 : 0);
    assert.equal(states.at(-1)?.entries.length, status === 503 ? 1 : 0);
    assert.doesNotMatch(states.at(-1)?.error ?? "", /PRIVATE|provider/i);
    resource.dispose();
  }
});
test("overlapping load-more pages and non-descending identities are never appended; abort suppresses delayed response", async () => {
  const states: BalanceHistoryState[] = [],
    controller = new AbortController();
  let calls = 0;
  const resource = createBalanceHistoryResource({
    userId: "1",
    signal: controller.signal,
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
    client: {
      balanceHistory: async () => {
        calls++;
        return { ...page(), nextCursor: "next" };
      },
    },
  });
  await resource.refresh();
  await resource.loadMore();
  assert.equal(states.at(-1)?.entries.length, 1);
  assert.ok(states.at(-1)?.error);
  assert.equal(calls, 2);
  controller.abort();
  await resource.refresh();
  assert.equal(calls, 2);
});

test("aborting a session suppresses an already pending history response", async () => {
  const controller = new AbortController(),
    states: BalanceHistoryState[] = [];
  let release: (value: BalanceHistoryPage) => void = () => {};
  const resource = createBalanceHistoryResource({
    userId: "1",
    signal: controller.signal,
    publish: (state) => states.push(state),
    onAccessDenied: () => assert.fail(),
    client: {
      balanceHistory: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  });
  const pending = resource.refresh(),
    count = states.length;
  controller.abort();
  release(page());
  await pending;
  assert.equal(states.length, count);
  resource.dispose();
});

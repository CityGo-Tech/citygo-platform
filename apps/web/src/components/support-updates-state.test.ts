import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import {
  createSupportUpdatesResource,
  type SupportUpdatesState,
} from "./support-updates-state";
const page = {
  userId: "1",
  unreadRequests: 1,
  unreadReplies: 2,
  requests: [{ requestId: "3", lastReplyId: "5", unreadReplies: 2 }],
  nextBefore: null,
};
test("support notice only reads metadata, replaces totals and clears immediately on abort and late delivery", async () => {
  const states: SupportUpdatesState[] = [],
    signal = new AbortController();
  let resolve!: (value: typeof page) => void,
    calls = 0;
  const resource = createSupportUpdatesResource({
    userId: "1",
    signal: signal.signal,
    client: {
      supportUpdates: async () => {
        calls++;
        return calls === 1 ? page : new Promise((r) => (resolve = r));
      },
    },
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
  });
  await resource.load();
  assert.deepEqual(states.at(-1)!.page, page);
  const pending = resource.load();
  signal.abort();
  assert.equal(states.at(-1)!.page, null);
  resolve(page);
  await pending;
  assert.equal(states.at(-1)!.page, null);
  assert.equal(states.at(-1)!.closed, true);
  resource.dispose();
});
test("wrong owner and forbidden session close the notice; retryable failure does not fabricate a zero count", async () => {
  for (const result of ["foreign", "401", "403", "network"]) {
    const states: SupportUpdatesState[] = [];
    let denied = 0;
    const resource = createSupportUpdatesResource({
      userId: "1",
      signal: new AbortController().signal,
      client: {
        supportUpdates: async () => {
          if (result === "foreign") return { ...page, userId: "2" };
          if (result === "network") throw Error();
          throw new ApiError(Number(result), "denied", "http");
        },
      },
      publish: (s) => states.push(s),
      onAccessDenied: () => denied++,
    });
    await resource.load();
    assert.equal(denied, result === "network" ? 0 : 1);
    assert.equal(states.at(-1)!.page, null);
    assert.equal(states.at(-1)!.closed, result !== "network");
    if (result === "network") assert.match(states.at(-1)!.error, /Не удалось/);
    resource.dispose();
  }
});

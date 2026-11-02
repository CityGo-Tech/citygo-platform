import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import {
  createAssistantContextResource,
  type AssistantContextView,
} from "./assistant-context-state";
import type { AssistantContextPreview } from "@citygo/contracts";
const value: AssistantContextPreview = {
  userId: "1",
  threadId: "2",
  generatedAt: "2026-11-02T00:00:00Z",
  profile: {
    targetCity: null,
    monthlyBudget: null,
    household: null,
    moveTargetDate: null,
  },
  agentKey: "support",
  closed: false,
  draftIncluded: true,
  messages: [
    { role: "user", content: "PRIVATE_QUESTION" },
    { role: "assistant", content: "PRIVATE_ANSWER" },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  read: (signal: AbortSignal) => Promise<AssistantContextPreview>,
) {
  const session = new AbortController();
  const scope = {
    userId: "1",
    threadId: "2",
    draft: "Новый вопрос",
    signal: session.signal,
  };
  let current = { ...scope, enabled: true };
  const views: AssistantContextView[] = [];
  let denied = 0;
  const action = createAssistantContextResource({
    scope,
    current: () => current,
    read,
    publish: (v) => views.push(v),
    onAccessDenied: () => denied++,
  });
  return {
    action,
    views,
    session,
    setCurrent: (next: Partial<typeof current>) => {
      current = { ...current, ...next };
    },
    denied: () => denied,
  };
}
test("opening preview only reads once; double click shares work and completion preserves the selected owner", async () => {
  const next = deferred<AssistantContextPreview>();
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return next.promise;
  });
  const first = f.action.load();
  await f.action.load();
  assert.equal(calls, 1);
  next.resolve(value);
  await first;
  assert.deepEqual(f.views.at(-1), { phase: "ready", value });
  assert.equal(f.denied(), 0);
  f.action.dispose();
});
test("close, expired session, changed owner/conversation and changed draft reject late private context", async () => {
  for (const change of ["close", "abort", "owner", "thread", "draft"]) {
    const next = deferred<AssistantContextPreview>();
    let signal!: AbortSignal;
    const f = setup(async (received) => {
      signal = received;
      return next.promise;
    });
    const loading = f.action.load();
    if (change === "close") f.action.dispose();
    if (change === "abort") f.session.abort();
    if (change === "owner") f.setCurrent({ userId: "3" });
    if (change === "thread") f.setCurrent({ threadId: "4" });
    if (change === "draft") f.setCurrent({ draft: "Другой вопрос" });
    next.resolve(value);
    await loading;
    assert.equal(
      f.views.some((view) => view.phase === "ready"),
      false,
    );
    assert.equal(f.denied(), 0);
    if (change === "close" || change === "abort")
      assert.equal(signal.aborted, true);
    f.action.dispose();
  }
});
test("a foreign response or current 401 is denied, but a delayed 401 after owner change cannot log out the new owner", async () => {
  const foreign = setup(async () => ({ ...value, userId: "9" }));
  await foreign.action.load();
  assert.equal(foreign.denied(), 1);
  assert.equal(
    foreign.views.some((v) => v.phase === "ready"),
    false,
  );
  const denied = setup(async () => {
    throw new ApiError(401, "Войдите");
  });
  await denied.action.load();
  assert.equal(denied.denied(), 1);
  const next = deferred<AssistantContextPreview>();
  const late = setup(async () => {
    await next.promise;
    throw new ApiError(401, "Войдите");
  });
  const reading = late.action.load();
  late.setCurrent({ userId: "8" });
  next.resolve(value);
  await reading;
  assert.equal(late.denied(), 0);
  late.action.dispose();
});

import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@citygo/api-client";
import type { PersonalPlanItem, PersonalPlanStatus } from "@citygo/contracts";
import { createPersonalPlanResource } from "./personal-plan-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let rows: PersonalPlanItem[] = Array.from({ length: 45 }, (_, i) => ({
    id: String(9007199254741100n - BigInt(i)),
    title: `Шаг ${i}`,
    details: "",
    status: i < 23 ? "completed" : "pending",
    revision: 1,
    source: { messageId: "11", threadId: "10", role: "assistant" },
    createdAt: "2026-10-28T10:00:00Z",
    updatedAt: "2026-10-28T10:00:00Z",
  }));
  const session = new AbortController();
  const reads: {
    before?: string;
    status?: PersonalPlanStatus;
    signal: AbortSignal;
  }[] = [];
  let denied = 0,
    changes = 0,
    responseOwner = "1",
    failMutation = false;
  const page = (before?: string, status?: PersonalPlanStatus) => {
    const matching = rows.filter(
      (item) =>
        (!before || BigInt(item.id) < BigInt(before)) &&
        (!status || item.status === status),
    );
    return {
      userId: "1",
      items: matching.slice(0, 20),
      nextBefore: matching.length > 20 ? matching[19]!.id : null,
    };
  };
  const client = {
    page: async (
      before: string | undefined,
      status: PersonalPlanStatus | undefined,
      signal: AbortSignal,
    ) => {
      reads.push({ before, status, signal });
      return page(before, status);
    },
    summary: async () => ({
      userId: responseOwner,
      total: rows.length,
      pending: rows.filter((x) => x.status === "pending").length,
      completed: rows.filter((x) => x.status === "completed").length,
    }),
    update: async (
      item: PersonalPlanItem,
      value: { title: string; details: string; status: PersonalPlanStatus },
    ) => {
      changes++;
      if (failMutation) throw new ApiError(409, "Conflict");
      rows = rows.map((entry) =>
        entry.id === item.id
          ? { ...entry, ...value, revision: entry.revision + 1 }
          : entry,
      );
      return { userId: "1", item: rows.find((entry) => entry.id === item.id)! };
    },
    remove: async (item: PersonalPlanItem) => {
      changes++;
      rows = rows.filter((entry) => entry.id !== item.id);
      return { userId: "1", itemId: item.id, removed: true as const };
    },
  };
  const resource = createPersonalPlanResource({
    userId: "1",
    sessionSignal: session.signal,
    client,
    publish: () => {},
    onAccessDenied: () => denied++,
  });
  return {
    resource,
    session,
    reads,
    client,
    page,
    denied: () => denied,
    changes: () => changes,
    badOwner: () => (responseOwner = "2"),
    conflict: () => (failMutation = true),
  };
}

test("server filter reaches rows beyond the first twenty and summary counts the whole personal plan", async () => {
  const s = setup();
  await s.resource.load();
  assert.equal(s.resource.snapshot().items.length, 20);
  assert.equal(s.resource.snapshot().summary?.total, 45);
  await s.resource.select("pending");
  assert.equal(s.reads.at(-1)?.status, "pending");
  assert.equal(s.resource.snapshot().items.length, 20);
  assert(
    s.resource.snapshot().items.every((item) => item.status === "pending"),
  );
  await s.resource.loadMore();
  assert.equal(s.resource.snapshot().items.length, 22);
  assert.equal(
    new Set(s.resource.snapshot().items.map((item) => item.id)).size,
    22,
  );
  assert.deepEqual(s.resource.snapshot().summary, {
    userId: "1",
    total: 45,
    pending: 22,
    completed: 23,
  });
});

test("switching status aborts an older page and its late response cannot replace the selected list", async () => {
  const s = setup();
  await s.resource.load();
  const gate = deferred<ReturnType<typeof s.page>>();
  const original = s.client.page;
  s.client.page = async (before, status, signal) =>
    before
      ? (s.reads.push({ before, status, signal }), gate.promise)
      : original(before, status, signal);
  const previous = s.resource.loadMore();
  const pendingSignal = s.reads.at(-1)!.signal;
  await s.resource.select("pending");
  assert.equal(pendingSignal.aborted, true);
  gate.resolve(s.page(s.reads.find((r) => r.before)?.before));
  await previous;
  assert.equal(s.resource.snapshot().filter, "pending");
  assert(
    s.resource.snapshot().items.every((item) => item.status === "pending"),
  );
  assert.equal(s.resource.snapshot().items.length, 20);
});

test("completion, reopening and deletion reread selected status and total rather than editing a loaded slice", async () => {
  const s = setup();
  await s.resource.select("pending");
  const first = s.resource.snapshot().items[0]!;
  assert.equal(
    await s.resource.update(first, {
      expectedRevision: first.revision,
      title: first.title,
      details: first.details,
      status: "completed",
    }),
    true,
  );
  assert(!s.resource.snapshot().items.some((entry) => entry.id === first.id));
  assert.equal(s.resource.snapshot().summary?.completed, 24);
  await s.resource.select("completed");
  const completed = s.resource.snapshot().items[0]!;
  await s.resource.update(completed, {
    expectedRevision: completed.revision,
    title: completed.title,
    details: completed.details,
    status: "pending",
  });
  assert.equal(s.resource.snapshot().summary?.pending, 22);
  await s.resource.remove(s.resource.snapshot().items[0]!);
  assert.equal(s.resource.snapshot().summary?.total, 44);
  assert.equal(s.changes(), 3);
});

test("uncertain mutation blocks another write until explicit refresh, and another summary owner closes all private state", async () => {
  const s = setup();
  await s.resource.load();
  const first = s.resource.snapshot().items[0]!;
  s.conflict();
  await s.resource.update(first, {
    expectedRevision: first.revision,
    title: first.title,
    details: first.details,
    status: "pending",
  });
  assert.equal(s.resource.snapshot().needsRefresh, true);
  assert.equal(s.resource.snapshot().summary, null);
  assert.equal(await s.resource.remove(first), false);
  assert.equal(s.changes(), 1);
  s.badOwner();
  await s.resource.load();
  assert.equal(s.denied(), 1);
  assert.equal(s.resource.snapshot().phase, "closed");
  assert.deepEqual(s.resource.snapshot().items, []);
});

test("owner session abort clears counts and a late page cannot repaint the previous plan", async () => {
  const s = setup();
  const gate = deferred<ReturnType<typeof s.page>>();
  s.client.page = () => gate.promise;
  const loading = s.resource.load();
  s.session.abort();
  gate.resolve(s.page());
  await loading;
  assert.equal(s.resource.snapshot().phase, "closed");
  assert.equal(s.resource.snapshot().summary, null);
  assert.deepEqual(s.resource.snapshot().items, []);
});

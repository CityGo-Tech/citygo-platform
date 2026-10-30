import assert from "node:assert/strict";
import test from "node:test";
import type {
  PersonalPlanItem,
  PersonalPlanItemResult,
} from "@citygo/contracts";
import { ApiError, createClient, createPersonalPlanResource } from "./index.js";

const item = (
  id: string,
  status: "pending" | "completed",
): PersonalPlanItem => ({
  id,
  title: `Шаг ${id}`,
  details: "",
  status,
  revision: 1,
  source: { messageId: "11", threadId: "10", role: "assistant" },
  createdAt: "2026-10-28T10:00:00Z",
  updatedAt: "2026-10-28T10:00:00Z",
});
const rows = [
  item("3", "pending"),
  item("2", "completed"),
  item("1", "pending"),
];
const summary = { userId: "1", total: 3, pending: 2, completed: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native per-request clients cancel filtered pagination and session reads without AbortSignal.any", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    configurable: true,
  });
  const session = new AbortController();
  const oldPage = deferred<Response>();
  const sessionPage = deferred<Response>();
  const pageRows = Array.from({ length: 21 }, (_, index) =>
    item(String(21 - index), index % 2 === 0 ? "pending" : "completed"),
  );
  const pendingRows = pageRows.filter((entry) => entry.status === "pending");
  const pageSummary = { userId: "1", total: 21, pending: 11, completed: 10 };
  const signals: AbortSignal[] = [];
  let holdPage = false;
  let denied = 0;
  const api = (signal: AbortSignal) =>
    createClient("http://synthetic", {
      native: true,
      token: () => "synthetic-session",
      signal: () => signal,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(
          new Headers(init?.headers).get("x-citygo-client"),
          "native",
        );
        if (url.pathname.endsWith("/summary"))
          return Response.json(pageSummary);
        signals.push(init!.signal!);
        if (url.searchParams.has("before")) return oldPage.promise;
        if (holdPage) return sessionPage.promise;
        const pending = url.searchParams.get("status") === "pending";
        return Response.json({
          userId: "1",
          items: pending ? pendingRows : pageRows.slice(0, 20),
          nextBefore: pending ? null : "2",
        });
      },
    });
  const resource = createPersonalPlanResource({
    userId: "1",
    sessionSignal: session.signal,
    client: {
      page: (before, status, signal) =>
        api(signal).personalPlan(before, status),
      summary: (signal) => api(signal).personalPlanSummary(),
      update: () => {
        throw new Error("Unexpected mutation");
      },
      remove: () => {
        throw new Error("Unexpected mutation");
      },
    },
    publish: () => {},
    onAccessDenied: () => denied++,
  });
  try {
    await resource.load();
    assert.equal(resource.snapshot().items.length, 20);
    const previous = resource.loadMore();
    const oldSignal = signals.at(-1)!;
    await resource.select("pending");
    assert.equal(oldSignal.aborted, true);
    await previous;
    oldPage.resolve(
      Response.json({ userId: "1", items: [pageRows[20]], nextBefore: null }),
    );
    assert.deepEqual(
      resource.snapshot().items.map((entry) => entry.id),
      pendingRows.map((entry) => entry.id),
    );
    assert.deepEqual(resource.snapshot().summary, pageSummary);

    holdPage = true;
    const loading = resource.load();
    const pendingSignal = signals.at(-1)!;
    session.abort();
    assert.equal(pendingSignal.aborted, true);
    await loading;
    sessionPage.resolve(
      Response.json({ userId: "1", items: rows, nextBefore: null }),
    );
    assert.equal(resource.snapshot().phase, "closed");
    assert.equal(resource.snapshot().summary, null);
    assert.deepEqual(resource.snapshot().items, []);
    assert.equal(denied, 0);
  } finally {
    resource.dispose();
    Object.defineProperty(AbortSignal, "any", descriptor);
  }
});

test("public ApiError identity closes the shared plan on denied access", async () => {
  let denied = 0;
  const resource = createPersonalPlanResource({
    userId: "1",
    sessionSignal: new AbortController().signal,
    client: {
      page: async () => ({ userId: "1", items: rows, nextBefore: null }),
      summary: async () => {
        throw new ApiError(403, "Forbidden");
      },
      update: () => {
        throw new Error("Unexpected mutation");
      },
      remove: () => {
        throw new Error("Unexpected mutation");
      },
    },
    publish: () => {},
    onAccessDenied: () => denied++,
  });
  await resource.load();
  assert.equal(denied, 1);
  assert.equal(resource.snapshot().phase, "closed");
  assert.deepEqual(resource.snapshot().items, []);
  resource.dispose();
});

test("disposing during a mutation aborts its signal and ignores a late receipt", async () => {
  const pending = deferred<PersonalPlanItemResult>();
  let signal: AbortSignal | undefined;
  let reads = 0;
  let publications = 0;
  const resource = createPersonalPlanResource({
    userId: "1",
    sessionSignal: new AbortController().signal,
    client: {
      page: async () => {
        reads++;
        return { userId: "1", items: rows, nextBefore: null };
      },
      summary: async () => summary,
      update: (_item, _value, requestSignal) => {
        signal = requestSignal;
        return pending.promise;
      },
      remove: () => {
        throw new Error("Unexpected mutation");
      },
    },
    publish: () => publications++,
    onAccessDenied: () => {
      throw new Error("Unexpected access denial");
    },
  });
  await resource.load();
  const first = rows[0]!;
  const saving = resource.update(first, {
    expectedRevision: first.revision,
    title: first.title,
    details: first.details,
    status: "completed",
  });
  const beforeDispose = publications;
  resource.dispose();
  assert.equal(signal?.aborted, true);
  pending.resolve({
    userId: "1",
    item: { ...first, status: "completed", revision: 2 },
  });
  assert.equal(await saving, false);
  assert.equal(reads, 1);
  assert.equal(publications, beforeDispose);
});

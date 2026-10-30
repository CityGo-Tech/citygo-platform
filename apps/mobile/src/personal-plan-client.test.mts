import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard, type PersonalPlanState } from "@citygo/api-client";
import {
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  type PersonalPlanItem,
} from "@citygo/contracts";
import { createMobilePersonalPlan } from "./personal-plan-client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION },
  });
const row = (id: string, completed = false): PersonalPlanItem => ({
  id,
  title: `Шаг ${id}`,
  details: "Уточнить район",
  status: completed ? "completed" : "pending",
  revision: 1,
  source: { messageId: "11", threadId: "10", role: "assistant" },
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
});
type Request = {
  url: URL;
  method: string;
  signal: AbortSignal;
  body?: unknown;
};
function setup(
  intercept?: (request: Request) => Response | Promise<Response> | undefined,
) {
  const session = createSessionGuard();
  session.reset("1");
  const requests: Request[] = [];
  const views: PersonalPlanState[] = [];
  let rows = Array.from({ length: 25 }, (_, index) =>
    row(String(100 - index), index < 3),
  );
  let denied = 0;
  const resource = createMobilePersonalPlan({
    base: "https://synthetic.invalid/api",
    token: "synthetic-plan-credential",
    userId: "1",
    sessionTicket: session.capture(),
    publish: (state) => views.push(state),
    onAccessDenied: () => denied++,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("Authorization"),
        "Bearer synthetic-plan-credential",
      );
      assert.equal(headers.get("X-CityGo-Client"), "native");
      assert.equal(headers.get(CONTRACT_VERSION_HEADER), CONTRACT_VERSION);
      assert.ok(init?.signal);
      const request: Request = {
        url: new URL(String(url)),
        method: init.method ?? "GET",
        signal: init.signal,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
      };
      requests.push(request);
      const custom = intercept?.(request);
      if (custom !== undefined) return custom;
      if (request.url.pathname === "/api/v1/personal-plan/summary")
        return json({
          userId: "1",
          total: rows.length,
          pending: rows.filter((item) => item.status === "pending").length,
          completed: rows.filter((item) => item.status === "completed").length,
        });
      if (
        request.url.pathname === "/api/v1/personal-plan" &&
        request.method === "GET"
      ) {
        const before = request.url.searchParams.get("before");
        const status = request.url.searchParams.get("status");
        const matching = rows.filter(
          (item) =>
            (!before || BigInt(item.id) < BigInt(before)) &&
            (!status || item.status === status),
        );
        return json({
          userId: "1",
          items: matching.slice(0, 20),
          nextBefore: matching.length > 20 ? matching[19]!.id : null,
        });
      }
      if (
        /^\/api\/v1\/personal-plan\/[0-9]+$/.test(request.url.pathname) &&
        request.method === "PATCH"
      ) {
        const id = request.url.pathname.split("/").at(-1)!;
        const item = rows.find((entry) => entry.id === id)!;
        const value = request.body as {
          expectedRevision: number;
          title: string;
          details: string;
          status: PersonalPlanItem["status"];
        };
        assert.equal(value.expectedRevision, item.revision);
        const updated = { ...item, ...value, revision: item.revision + 1 };
        delete (updated as Partial<typeof value>).expectedRevision;
        rows = rows.map((entry) => (entry.id === id ? updated : entry));
        return json({ userId: "1", item: updated });
      }
      assert.fail("Unexpected native plan request: " + request.url.pathname);
    },
  });
  return {
    resource,
    requests,
    views,
    session,
    denied: () => denied,
  };
}

test("native plan uses the pinned credential and native contract for pages, filters and global progress only", async () => {
  const f = setup();
  await f.resource.load();
  assert.equal(f.resource.snapshot().summary?.total, 25);
  assert.equal(f.resource.snapshot().items.length, 20);
  await f.resource.loadMore();
  assert.equal(f.resource.snapshot().items.length, 25);
  assert.equal(f.requests[2]!.url.searchParams.get("before"), "81");
  await f.resource.select("pending");
  assert.equal(f.requests[4]!.url.searchParams.get("status"), "pending");
  await f.resource.loadMore();
  assert.equal(f.resource.snapshot().items.length, 22);
  assert.deepEqual(f.resource.snapshot().summary, {
    userId: "1",
    total: 25,
    pending: 22,
    completed: 3,
  });
  assert.ok(f.requests.every((request) => request.method === "GET"));
  assert.ok(
    f.requests.every((request) =>
      ["/api/v1/personal-plan", "/api/v1/personal-plan/summary"].includes(
        request.url.pathname,
      ),
    ),
  );
  f.resource.dispose();
});

test("native plan forwards filter cancellation to fetch and ignores the old page's late 401", async () => {
  const response = deferred<Response>();
  const started = deferred<AbortSignal>();
  const f = setup((request) => {
    if (request.url.searchParams.has("before")) {
      started.resolve(request.signal);
      return response.promise;
    }
  });
  await f.resource.load();
  const oldPage = f.resource.loadMore();
  const signal = await started.promise;
  await f.resource.select("pending");
  assert.equal(signal.aborted, true);
  response.resolve(json({ error: "Old request" }, 401));
  await oldPage;
  assert.equal(f.denied(), 0);
  assert.equal(f.resource.snapshot().filter, "pending");
  assert.equal(f.resource.snapshot().phase, "ready");
  f.resource.dispose();
});

test("native plan rejects another owner and an active access denial without exposing steps", async () => {
  for (const response of [
    json({ userId: "2", total: 0, pending: 0, completed: 0 }),
    json({ error: "Session ended" }, 401),
    json({ error: "Access denied" }, 403),
  ]) {
    const f = setup((request) =>
      request.url.pathname.endsWith("/summary") ? response : undefined,
    );
    await f.resource.load();
    assert.equal(f.denied(), 1);
    assert.equal(f.resource.snapshot().phase, "closed");
    assert.equal(f.resource.snapshot().items.length, 0);
    assert.equal(f.resource.snapshot().summary, null);
    f.resource.dispose();
  }
});

test("native completion sends one revision-bound PATCH then reloads the selected filter and totals", async () => {
  const f = setup();
  await f.resource.select("pending");
  const first = f.resource.snapshot().items[0]!;
  assert.equal(
    await f.resource.update(first, {
      expectedRevision: first.revision,
      title: first.title,
      details: first.details,
      status: "completed",
    }),
    true,
  );
  const patches = f.requests.filter((request) => request.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.url.pathname, `/api/v1/personal-plan/${first.id}`);
  assert.deepEqual(patches[0]!.body, {
    expectedRevision: 1,
    title: first.title,
    details: first.details,
    status: "completed",
  });
  assert.equal(f.resource.snapshot().filter, "pending");
  assert.equal(f.resource.snapshot().summary?.completed, 4);
  assert.equal(
    f.resource.snapshot().items.some((item) => item.id === first.id),
    false,
  );
  assert.equal(f.requests.at(-2)!.url.searchParams.get("status"), "pending");
  f.resource.dispose();
});

test("native plan clears and aborts on session replacement, and late denial cannot end the next session", async () => {
  const response = deferred<Response>();
  const started = deferred<AbortSignal>();
  const f = setup((request) => {
    if (request.url.pathname.endsWith("/summary")) {
      started.resolve(request.signal);
      return response.promise;
    }
  });
  const load = f.resource.load();
  const signal = await started.promise;
  f.session.reset("2");
  assert.equal(signal.aborted, true);
  assert.equal(f.resource.snapshot().phase, "closed");
  assert.equal(f.resource.snapshot().items.length, 0);
  response.resolve(json({ error: "Previous session" }, 401));
  await load;
  assert.equal(f.denied(), 0);
  assert.equal(f.resource.snapshot().phase, "closed");
  f.resource.dispose();
});

test("native plan disposal aborts the view without changing the session or publishing late data", async () => {
  const response = deferred<Response>();
  const started = deferred<AbortSignal>();
  const f = setup((request) => {
    if (request.url.pathname.endsWith("/summary")) {
      started.resolve(request.signal);
      return response.promise;
    }
  });
  const load = f.resource.load();
  const signal = await started.promise;
  f.resource.dispose();
  const published = f.views.length;
  assert.equal(signal.aborted, true);
  response.resolve(json({ userId: "1", total: 0, pending: 0, completed: 0 }));
  await load;
  assert.equal(f.views.length, published);
  assert.equal(f.session.capture().active(), true);
  assert.equal(f.denied(), 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { SupportRequest } from "@citygo/contracts";
import {
  createHumanSupportResource,
  type SupportState,
} from "./human-support-state";
const item: SupportRequest = {
  id: "9007199254740993",
  operationId: "41111111-1111-4111-8111-111111111111",
  body: "Помогите разобраться с первым шагом моего переезда.",
  status: "open",
  revision: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  closedAt: null,
};
const closed: SupportRequest = {
  ...item,
  status: "closed",
  revision: 2,
  updatedAt: "2026-11-01T00:01:00Z",
  closedAt: "2026-11-01T00:01:00Z",
};
type Options = Parameters<typeof createHumanSupportResource>[0];
function harness(client: Partial<Options["client"]> = {}) {
  const states: SupportState[] = [],
    controller = new AbortController();
  let denied = 0;
  const resource = createHumanSupportResource({
    userId: "1",
    signal: controller.signal,
    publish: (s) => states.push(s),
    operationId: () => item.operationId,
    onAccessDenied: () => {
      denied++;
    },
    client: {
      supportRequests: async () => ({
        userId: "1",
        requests: [item],
        nextBefore: null,
      }),
      createSupportRequest: async () => {
        throw new Error("not expected");
      },
      ...client,
    },
  });
  return { states, resource, controller, denied: () => denied };
}

test("changing support filter supersedes old pagination without accepting mixed statuses or losing a draft", async () => {
  let finish!: (v: {
    userId: string;
    requests: SupportRequest[];
    nextBefore: null;
  }) => void;
  const oldPage = new Promise<{
    userId: string;
    requests: SupportRequest[];
    nextBefore: null;
  }>((r) => {
    finish = r;
  });
  const calls: unknown[] = [];
  const f = harness({
    supportRequests: async (q) => {
      calls.push(q);
      if (q?.before) return oldPage;
      return {
        userId: "1",
        requests: q?.status === "closed" ? [closed] : [item],
        nextBefore: null,
      };
    },
  });
  await f.resource.load();
  const late = f.resource.load(item.id);
  await f.resource.setFilter("closed");
  finish({ userId: "1", requests: [{ ...item, id: "2" }], nextBefore: null });
  await late;
  assert.equal(f.states.at(-1)?.statusFilter, "closed");
  assert.deepEqual(f.states.at(-1)?.requests, [closed]);
  assert.deepEqual(calls, [{}, { before: item.id }, { status: "closed" }]);
  assert.equal(f.states.at(-1)?.busy, false);
  assert.equal(f.states.at(-1)?.nextBefore, null);
});

test("support filters reject a page outside the chosen status instead of publishing it", async () => {
  const f = harness();
  await f.resource.setFilter("closed");
  assert.deepEqual(f.states.at(-1)?.requests, []);
  assert.equal(f.states.at(-1)?.loaded, false);
  assert.notEqual(f.states.at(-1)?.error, "");
});

test("a lost status receipt disables another mutation until explicit fresh owner read", async () => {
  let writes = 0;
  let current = item;
  const f = harness({
    supportRequest: async () => ({ userId: "1", request: current }),
    setOwnSupportRequestStatus: async (_id, input) => {
      writes++;
      if (writes === 1) {
        current = closed;
        throw new Error("lost after commit");
      }
      assert.equal(input.expectedRevision, 2);
      current = { ...item, revision: 3, updatedAt: "2026-11-01T00:02:00Z" };
      return { userId: "1", request: current };
    },
  });
  await f.resource.load();
  assert.equal(await f.resource.changeStatus(item.id, "closed", 1), false);
  assert.equal(f.states.at(-1)?.uncertainRequestId, item.id);
  assert.equal(f.states.at(-1)?.requests[0]?.status, "open");
  await f.resource.changeStatus(item.id, "closed", 1);
  assert.equal(writes, 1);
  assert.equal(await f.resource.open(item.id), true);
  assert.equal(f.states.at(-1)?.uncertainRequestId, null);
  assert.equal(f.states.at(-1)?.requests[0]?.revision, 2);
  assert.equal(await f.resource.changeStatus(item.id, "open", 2), true);
  assert.equal(writes, 2);
  assert.match(f.states.at(-1)?.statusMessage ?? "", /снова открыто/);
});

test("a successful close leaves the current open filter and preserves cursor without acknowledging replies", async () => {
  let writes = 0;
  const f = harness({
    setOwnSupportRequestStatus: async (id, command) => {
      writes++;
      assert.equal(id, item.id);
      assert.deepEqual(command, { expectedRevision: 1, status: "closed" });
      return { userId: "1", request: closed };
    },
  });
  await f.resource.setFilter("open");
  assert.equal(await f.resource.changeStatus(item.id, "closed", 1), true);
  assert.deepEqual(f.states.at(-1)?.requests, []);
  assert.equal(f.states.at(-1)?.statusFilter, "open");
  assert.equal(f.states.at(-1)?.nextBefore, null);
  assert.equal(writes, 1);
  assert.match(f.states.at(-1)?.statusMessage ?? "", /Переписка сохранена/);
});

test("a stale rendered revision cannot silently act on a newly read support state", async () => {
  let writes = 0;
  const f = harness({
    supportRequests: async () => ({
      userId: "1",
      requests: [closed],
      nextBefore: null,
    }),
    setOwnSupportRequestStatus: async () => {
      writes++;
      throw new Error("must not write");
    },
  });
  await f.resource.load();
  assert.equal(await f.resource.changeStatus(item.id, "open", 1), false);
  assert.equal(writes, 0);
  assert.equal(f.states.at(-1)?.uncertainRequestId, item.id);
});

test("session abort suppresses a late status result; forged owner clears cached private rows", async () => {
  let finish!: (v: { userId: string; request: SupportRequest }) => void;
  const delayed = new Promise<{ userId: string; request: SupportRequest }>(
    (r) => {
      finish = r;
    },
  );
  const f = harness({ setOwnSupportRequestStatus: () => delayed });
  await f.resource.load();
  const pending = f.resource.changeStatus(item.id, "closed");
  const count = f.states.length;
  f.controller.abort();
  finish({ userId: "1", request: closed });
  await pending;
  assert.equal(f.states.length, count);
  const g = harness({
    setOwnSupportRequestStatus: async () => ({ userId: "2", request: closed }),
  });
  await g.resource.load();
  await g.resource.changeStatus(item.id, "closed");
  assert.equal(g.denied(), 1);
  assert.deepEqual(g.states.at(-1)?.requests, []);
  assert.equal(g.states.at(-1)?.receipt, null);
});

test("uncertain create keeps its immutable operation and prevents filter/status mutation", async () => {
  let writes = 0;
  const f = harness({
    createSupportRequest: async () => {
      throw new Error("lost create response");
    },
    setOwnSupportRequestStatus: async () => {
      writes++;
      return { userId: "1", request: closed };
    },
  });
  await f.resource.load();
  await f.resource.send(item.body);
  const pending = f.states.at(-1)?.pending;
  await f.resource.setFilter("closed");
  await f.resource.changeStatus(item.id, "closed");
  assert.equal(f.states.at(-1)?.statusFilter, "all");
  assert.deepEqual(f.states.at(-1)?.pending, pending);
  assert.equal(writes, 0);
});

test("definitive CAS conflict does not retry and requires an explicit fresh read", async () => {
  let writes = 0;
  const f = harness({
    setOwnSupportRequestStatus: async () => {
      writes++;
      throw new ApiError(409, "changed", "http");
    },
  });
  await f.resource.load();
  await f.resource.changeStatus(item.id, "closed");
  await f.resource.changeStatus(item.id, "closed");
  assert.equal(writes, 1);
  assert.match(f.states.at(-1)?.error ?? "", /изменилось/);
});

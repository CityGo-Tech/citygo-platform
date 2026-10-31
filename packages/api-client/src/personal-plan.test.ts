import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION_HEADER,
  type PersonalPlanItem,
} from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";

const create = {
  operationId: "11111111-1111-4111-8111-111111111111",
  sourceMessageId: "9007199254740993",
  title: "Проверить маршрут",
  details: "Выбрать следующий шаг",
};
const item: PersonalPlanItem = {
  id: "42",
  title: create.title,
  details: create.details,
  status: "pending",
  revision: 1,
  source: {
    messageId: create.sourceMessageId,
    threadId: "2",
    role: "assistant",
  },
  createdAt: "2026-10-24T12:00:00Z",
  updatedAt: "2026-10-24T12:00:00Z",
};
const invalid = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";

test("personal plan filtered reads preserve old call and reject mismatched status; summary accepts only consistent bounded counts", async () => {
  const paths: string[] = [];
  let response: unknown = { userId: "1", items: [item], nextBefore: null };
  const client = createClient("http://synthetic", {
    fetch: async (url) => {
      paths.push(String(url));
      return Response.json(response);
    },
  });
  await client.personalPlan();
  await client.personalPlan("9007199254740993", "pending");
  await client.personalPlan(undefined, "pending");
  assert.deepEqual(paths, [
    "http://synthetic/v1/personal-plan",
    "http://synthetic/v1/personal-plan?before=9007199254740993&status=pending",
    "http://synthetic/v1/personal-plan?status=pending",
  ]);
  await assert.rejects(client.personalPlan(undefined, "completed"), invalid);
  const before = paths.length;
  await assert.rejects(client.personalPlan(undefined, "all" as "pending"));
  assert.equal(paths.length, before);
  const summary = { userId: "1", total: 200, pending: 123, completed: 77 };
  response = summary;
  assert.deepEqual(await client.personalPlanSummary(), summary);
  assert.equal(paths.at(-1), "http://synthetic/v1/personal-plan/summary");
  for (const change of [
    { total: 201 },
    { total: 199 },
    { pending: -1 },
    { completed: 1.1 },
    { pending: "123" },
    { userId: "01" },
    { extra: true },
  ]) {
    response = { ...summary, ...change };
    await assert.rejects(client.personalPlanSummary(), invalid);
  }
});

test("personal plan client uses exact verbs, normalized commands and existing transport headers", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const update = {
    expectedRevision: 1,
    title: "Следующий шаг",
    details: "",
    status: "completed" as const,
  };
  const client = createClient("http://synthetic", {
    native: true,
    token: () => "synthetic-session",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(CONTRACT_VERSION_HEADER), "1");
      assert.equal(headers.get("authorization"), "Bearer synthetic-session");
      assert.equal(headers.get("x-citygo-client"), "native");
      calls.push({
        path: String(url),
        method: init!.method!,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        init?.method === "GET"
          ? { userId: "1", items: [item], nextBefore: null }
          : init?.method === "PATCH"
            ? {
                userId: "1",
                item: {
                  ...item,
                  ...update,
                  revision: 2,
                  expectedRevision: undefined,
                },
              }
            : init?.method === "DELETE"
              ? { userId: "1", itemId: item.id, removed: true }
              : { userId: "1", item },
      );
    },
  });
  assert.equal(
    (await client.personalPlan("9007199254740993")).items[0]!.id,
    "42",
  );
  await client.createPersonalPlanItem({
    ...create,
    title: "  Проверить маршрут  ",
  });
  await client.updatePersonalPlanItem(item.id, update);
  await client.removePersonalPlanItem(item.id, 2);
  assert.deepEqual(calls, [
    {
      path: "http://synthetic/v1/personal-plan?before=9007199254740993",
      method: "GET",
      body: null,
    },
    { path: "http://synthetic/v1/personal-plan", method: "POST", body: create },
    {
      path: "http://synthetic/v1/personal-plan/42",
      method: "PATCH",
      body: update,
    },
    {
      path: "http://synthetic/v1/personal-plan/42",
      method: "DELETE",
      body: { expectedRevision: 2 },
    },
  ]);
});

test("personal plan client validates source/item/state correlations and page bounds", async () => {
  let response: unknown;
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(response),
  });
  response = {
    userId: "1",
    item: { ...item, source: { ...item.source, messageId: "9" } },
  };
  await assert.rejects(client.createPersonalPlanItem(create), invalid);
  // Replay may return the latest edited item, not the original creation title.
  response = {
    userId: "1",
    item: { ...item, title: "После исправления", revision: 3 },
  };
  assert.equal((await client.createPersonalPlanItem(create)).item.revision, 3);
  const update = {
    expectedRevision: 1,
    title: item.title,
    details: item.details,
    status: item.status,
  };
  for (const changed of [
    { id: "43", revision: 2 },
    { revision: 1 },
    { revision: 3 },
    { title: "Не тот результат", revision: 2 },
  ]) {
    response = { userId: "1", item: { ...item, ...changed } };
    await assert.rejects(
      client.updatePersonalPlanItem(item.id, update),
      invalid,
    );
  }
  response = { userId: "1", itemId: "43", removed: true };
  await assert.rejects(client.removePersonalPlanItem(item.id, 1), invalid);
  response = { userId: "1", items: [{ ...item, id: "50" }], nextBefore: null };
  await assert.rejects(client.personalPlan("50"), invalid);
  response = { userId: "1", items: [], nextBefore: null, ownerId: "2" };
  await assert.rejects(client.personalPlan(), invalid);
});

test("personal plan client rejects malformed command IDs before any fetch", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const id of ["1\n", "01", "0", "../admin", "9223372036854775808"]) {
    await assert.rejects(client.personalPlan(id));
    await assert.rejects(
      client.updatePersonalPlanItem(id, {
        expectedRevision: 1,
        title: "Шаг",
        details: "",
        status: "pending",
      }),
    );
    await assert.rejects(client.removePersonalPlanItem(id, 1));
    await assert.rejects(
      client.createPersonalPlanItem({ ...create, sourceMessageId: id }),
    );
  }
  await assert.rejects(client.removePersonalPlanItem("42", 0));
  await assert.rejects(
    client.createPersonalPlanItem({ ...create, title: " " }),
  );
  assert.equal(calls, 0);
});

test("personal plan conflicts retain revision metadata with no retry; protected 401 invalidates the session", async () => {
  let calls = 0,
    invalidations = 0;
  const client = createClient("http://synthetic", {
    onUnauthorized: () => invalidations++,
    fetch: async () => {
      calls++;
      return calls === 1
        ? Response.json(
            {
              error: "Шаг уже изменён",
              code: "REVISION_CONFLICT",
              currentVersion: 4,
              retryable: false,
            },
            { status: 409 },
          )
        : Response.json({ error: "Войдите снова" }, { status: 401 });
    },
  });
  await assert.rejects(
    client.removePersonalPlanItem("42", 1),
    (error: unknown) =>
      error instanceof ApiError &&
      error.serverCode === "REVISION_CONFLICT" &&
      error.currentVersion === 4 &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.personalPlan(),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(calls, 2);
  assert.equal(invalidations, 1);
});

test("personal plan commands obey session cancellation before dispatch and during a delayed response", async () => {
  const cancelled = (error: unknown) =>
    error instanceof ApiError && error.code === "aborted";
  const pre = new AbortController();
  pre.abort();
  let calls = 0;
  const early = createClient("http://synthetic", {
    signal: () => pre.signal,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(early.createPersonalPlanItem(create), cancelled);
  assert.equal(calls, 0);
  const controller = new AbortController();
  let release!: (response: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = createClient("http://synthetic", {
    signal: () => controller.signal,
    fetch: async () => {
      started();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = client.createPersonalPlanItem(create);
  await entered;
  controller.abort();
  await assert.rejects(pending, cancelled);
  release(Response.json({ userId: "1", item }));
});

test("manual plan client requires a null source receipt and keeps message-bound commands strict", async () => {
  let response = {
    userId: "1",
    item: { ...item, source: null } as PersonalPlanItem,
  };
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(response),
  });
  assert.equal(
    (await client.createPersonalPlanItem({ ...create, sourceMessageId: null }))
      .item.source,
    null,
  );
  await assert.rejects(client.createPersonalPlanItem(create), invalid);
  response = { userId: "1", item };
  await assert.rejects(
    client.createPersonalPlanItem({ ...create, sourceMessageId: null }),
    invalid,
  );
});

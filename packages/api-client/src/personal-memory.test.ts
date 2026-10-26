import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_VERSION_HEADER,
  type PersonalMemoryItem,
} from "@citygo/contracts";
import { ApiError, createClient } from "./index.js";

const create = {
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceMessageId: "9007199254740993",
  label: "Срок переезда",
  value: "Срок пока неизвестен",
  confirmed: true as const,
};
const item: PersonalMemoryItem = {
  id: "42",
  label: create.label,
  value: create.value,
  revision: 1,
  source: { messageId: create.sourceMessageId, threadId: "2", role: "user" },
  createdAt: "2026-10-25T06:00:00Z",
  updatedAt: "2026-10-25T06:00:00Z",
};
const invalid = (error: unknown) =>
  error instanceof ApiError && error.code === "invalid_response";

test("memory client uses exact methods, confirmed normalized commands and authenticated transport", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const update = {
    expectedRevision: 1,
    label: "С кем переезжаю",
    value: "С партнёром",
    confirmed: true as const,
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
          ? { userId: "1", items: [item] }
          : init?.method === "PATCH"
            ? {
                userId: "1",
                item: {
                  ...item,
                  label: update.label,
                  value: update.value,
                  revision: 2,
                },
              }
            : init?.method === "DELETE"
              ? { userId: "1", itemId: item.id, removed: true }
              : { userId: "1", item },
      );
    },
  });
  assert.equal((await client.listPersonalMemory()).items[0]!.id, "42");
  await client.createPersonalMemoryItem({
    ...create,
    label: "  Срок переезда  ",
  });
  await client.updatePersonalMemoryItem("42", update);
  await client.removePersonalMemoryItem("42", 2);
  assert.deepEqual(calls, [
    { path: "http://synthetic/v1/personal-memory", method: "GET", body: null },
    {
      path: "http://synthetic/v1/personal-memory",
      method: "POST",
      body: create,
    },
    {
      path: "http://synthetic/v1/personal-memory/42",
      method: "PATCH",
      body: update,
    },
    {
      path: "http://synthetic/v1/personal-memory/42",
      method: "DELETE",
      body: { expectedRevision: 2 },
    },
  ]);
});

test("memory client rejects mismatched sources, wrong correction receipts and malformed complete lists", async () => {
  let response: unknown;
  const client = createClient("http://synthetic", {
    fetch: async () => Response.json(response),
  });
  response = {
    userId: "1",
    item: { ...item, source: { ...item.source, messageId: "9" } },
  };
  await assert.rejects(client.createPersonalMemoryItem(create), invalid);
  response = {
    userId: "1",
    item: { ...item, label: "После исправления", revision: 3 },
  };
  assert.equal(
    (await client.createPersonalMemoryItem(create)).item.revision,
    3,
  );
  const update = {
    expectedRevision: 1,
    label: item.label,
    value: item.value,
    confirmed: true as const,
  };
  for (const change of [
    { id: "43", revision: 2 },
    { revision: 1 },
    { revision: 3 },
    { label: "Подмена", revision: 2 },
    { value: "Подмена", revision: 2 },
  ]) {
    response = { userId: "1", item: { ...item, ...change } };
    await assert.rejects(
      client.updatePersonalMemoryItem("42", update),
      invalid,
    );
  }
  response = { userId: "1", itemId: "43", removed: true };
  await assert.rejects(client.removePersonalMemoryItem("42", 1), invalid);
  for (const items of [
    [item, item],
    [{ ...item, id: "1" }, item],
    Array.from({ length: 21 }, (_, i) => ({ ...item, id: String(100 - i) })),
  ]) {
    response = { userId: "1", items };
    await assert.rejects(client.listPersonalMemory(), invalid);
  }
  response = { userId: "1", items: [], nextBefore: "1" };
  await assert.rejects(client.listPersonalMemory(), invalid);
});

test("memory commands fail before dispatch without explicit confirmation or canonical selectors", async () => {
  let calls = 0;
  const client = createClient("http://synthetic", {
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const id of ["1\n", "01", "0", "../admin", "9223372036854775808"]) {
    await assert.rejects(
      client.createPersonalMemoryItem({ ...create, sourceMessageId: id }),
    );
    await assert.rejects(
      client.updatePersonalMemoryItem(id, {
        expectedRevision: 1,
        label: item.label,
        value: item.value,
        confirmed: true,
      }),
    );
    await assert.rejects(client.removePersonalMemoryItem(id, 1));
  }
  await assert.rejects(
    client.createPersonalMemoryItem({ ...create, confirmed: false } as never),
  );
  await assert.rejects(
    client.updatePersonalMemoryItem("42", {
      expectedRevision: 1,
      label: "Поле",
      value: "Текст",
    } as never),
  );
  await assert.rejects(client.removePersonalMemoryItem("42", 0));
  assert.equal(calls, 0);
});

test("memory conflicts retain revision and never retry; protected 401 expires the client session", async () => {
  let calls = 0,
    invalidations = 0;
  const client = createClient("http://synthetic", {
    onUnauthorized: () => invalidations++,
    fetch: async () => {
      calls++;
      return calls === 1
        ? Response.json(
            {
              error: "Сведение изменилось",
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
    client.removePersonalMemoryItem("42", 1),
    (error: unknown) =>
      error instanceof ApiError &&
      error.serverCode === "REVISION_CONFLICT" &&
      error.currentVersion === 4 &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.listPersonalMemory(),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(calls, 2);
  assert.equal(invalidations, 1);
});

test("memory requests obey cancellation before dispatch and suppress late receipts", async () => {
  const cancelled = (error: unknown) =>
    error instanceof ApiError && error.code === "aborted";
  const early = new AbortController();
  early.abort();
  let calls = 0;
  const pre = createClient("http://synthetic", {
    signal: () => early.signal,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(pre.createPersonalMemoryItem(create), cancelled);
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
  const pending = client.createPersonalMemoryItem(create);
  await entered;
  controller.abort();
  await assert.rejects(pending, cancelled);
  release(Response.json({ userId: "1", item }));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  createClient,
  createPersonalPlanHistoryResource,
} from "./index.js";
import type { PersonalPlanHistoryPage } from "@citygo/contracts";
const entry = (revision: number) => ({
  revision,
  title: "Шаг " + revision,
  details: "Личный текст",
  status: "pending" as const,
  checklist: [],
  initialSnapshot: false,
  recordedAt: "2026-11-01T12:00:00Z",
});
const page = (
  revisions = [3, 2],
  nextBefore: number | null = 2,
): PersonalPlanHistoryPage => ({
  userId: "1",
  itemId: "9007199254741001",
  currentRevision: 3,
  entries: revisions.map(entry),
  nextBefore,
});
test("history client validates cursors and exact item before any private result is used", async () => {
  const paths: string[] = [];
  let response = page();
  const client = createClient("http://synthetic", {
    fetch: async (input) => {
      paths.push(String(input));
      return Response.json(response);
    },
  });
  assert.deepEqual(await client.personalPlanHistory(response.itemId), response);
  response = page([1], null);
  await client.personalPlanHistory(response.itemId, 2);
  assert.deepEqual(paths, [
    "http://synthetic/v1/personal-plan/9007199254741001/history",
    "http://synthetic/v1/personal-plan/9007199254741001/history?before=2",
  ]);
  const count = paths.length;
  await assert.rejects(
    client.personalPlanHistory(response.itemId, Number.MAX_SAFE_INTEGER + 1),
  );
  assert.equal(paths.length, count);
  await assert.rejects(
    client.personalPlanHistory("2"),
    (error) => error instanceof ApiError && error.code === "invalid_response",
  );
  response = page();
  await assert.rejects(client.personalPlanHistory(response.itemId, 2));
});
test("history state replaces bounded pages, preserves comparison anchor and rejects a concurrent edit", async () => {
  const calls: (number | undefined)[] = [];
  let response = page();
  let denied = 0;
  const session = new AbortController();
  const resource = createPersonalPlanHistoryResource({
    userId: "1",
    itemId: response.itemId,
    signal: session.signal,
    read: async (before) => {
      calls.push(before);
      return response;
    },
    publish: () => {},
    onAccessDenied: () => denied++,
  });
  await resource.load();
  const old = resource.snapshot();
  old.current!.title = "corrupt clone";
  response = page([1], null);
  await resource.earlier();
  assert.deepEqual(
    resource.snapshot().entries.map((row) => row.revision),
    [1],
  );
  assert.equal(resource.snapshot().current!.title, "Шаг 3");
  response = page();
  await resource.load();
  response = { ...page([1], null), currentRevision: 4 };
  await resource.earlier();
  assert.equal(resource.snapshot().phase, "error");
  assert.equal(resource.snapshot().current, null);
  assert.deepEqual(resource.snapshot().entries, []);
  response = { ...page(), userId: "2" };
  await resource.load();
  assert.equal(denied, 1);
  assert.equal(resource.snapshot().phase, "closed");
  assert.deepEqual(calls, [undefined, 2, undefined, 2, undefined]);
  resource.dispose();
});
test("history abort clears private state and ignores late responses even when transport ignores abort", async () => {
  let done!: (page: PersonalPlanHistoryPage) => void;
  const pending = new Promise<PersonalPlanHistoryPage>((resolve) => {
    done = resolve;
  });
  const session = new AbortController();
  const resource = createPersonalPlanHistoryResource({
    userId: "1",
    itemId: page().itemId,
    signal: session.signal,
    read: () => pending,
    publish: () => {},
    onAccessDenied: () => assert.fail("not an access error"),
  });
  const read = resource.load();
  session.abort();
  done(page());
  await read;
  assert.equal(resource.snapshot().phase, "closed");
  assert.deepEqual(resource.snapshot().entries, []);
  assert.equal(resource.snapshot().current, null);
  resource.dispose();
});

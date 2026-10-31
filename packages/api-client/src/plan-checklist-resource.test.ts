import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ApiError } from "./transport.js";
import { createPlanChecklistResource } from "./plan-checklist-resource.js";
import type { PlanChecklist } from "@citygo/contracts";
function fixture() {
  const controller = new AbortController();
  let denied = 0,
    saved = 0,
    calls = 0,
    writeError: Error | null = null;
  let value: PlanChecklist = {
    userId: "101",
    itemId: "20",
    revision: 1,
    entries: [],
  };
  const resource = createPlanChecklistResource({
    userId: "101",
    itemId: "20",
    sessionSignal: controller.signal,
    publish: () => {},
    onAccessDenied: () => denied++,
    onSaved: () => saved++,
    client: {
      get: async () => value,
      save: async (revision, entries) => {
        calls++;
        if (writeError) throw writeError;
        value = { ...value, revision: revision + 1, entries };
        return value;
      },
    },
  });
  return {
    resource,
    controller,
    denied: () => denied,
    saved: () => saved,
    calls: () => calls,
    setValue: (next: PlanChecklist) => {
      value = next;
    },
    setError: (error: Error) => {
      writeError = error;
    },
  };
}
test("checklist writes are explicit full snapshots and uncertain CAS writes cannot be retried before an authorized read", async () => {
  const f = fixture();
  await f.resource.load();
  const entry = {
    id: randomUUID(),
    title: "Платежи",
    details: "",
    completed: false,
  };
  assert.equal(await f.resource.save([entry]), true);
  assert.equal(f.saved(), 1);
  assert.equal(f.calls(), 1);
  const snap = f.resource.snapshot();
  snap.value!.entries[0]!.title = "Mutation";
  assert.equal(f.resource.snapshot().value!.entries[0]!.title, "Платежи");
  f.setError(new ApiError(409, "Conflict"));
  assert.equal(await f.resource.save([]), false);
  assert.equal(f.resource.snapshot().needsRefresh, true);
  assert.equal(await f.resource.save([]), false);
  assert.equal(f.calls(), 2);
  await f.resource.load();
  assert.equal(f.resource.snapshot().needsRefresh, false);
  f.resource.dispose();
});
test("checklist owner denial clears entries and session disposal aborts pending writes without late publication", async () => {
  const f = fixture();
  f.setValue({ userId: "102", itemId: "20", revision: 1, entries: [] });
  await f.resource.load();
  assert.equal(f.denied(), 1);
  assert.equal(f.resource.snapshot().value, null);
  const controller = new AbortController();
  let finish!: (value: PlanChecklist) => void;
  let signal!: AbortSignal;
  let saved = 0;
  let publications = 0;
  const value: PlanChecklist = {
    userId: "101",
    itemId: "20",
    revision: 1,
    entries: [],
  };
  const resource = createPlanChecklistResource({
    userId: "101",
    itemId: "20",
    sessionSignal: controller.signal,
    publish: () => publications++,
    onAccessDenied: () => assert.fail("late denial"),
    onSaved: () => saved++,
    client: {
      get: async () => value,
      save: async (_revision, _entries, request) => {
        signal = request;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  await resource.load();
  const pending = resource.save([]);
  controller.abort();
  assert.equal(signal.aborted, true);
  const after = publications;
  finish({ ...value, revision: 2 });
  assert.equal(await pending, false);
  assert.equal(publications, after);
  assert.equal(saved, 0);
  assert.equal(resource.snapshot().value, null);
  resource.dispose();
});
test("active checklist 401 and 403 close access and never retain a private response", async () => {
  for (const status of [401, 403]) {
    const f = fixture();
    await f.resource.load();
    f.setError(new ApiError(status, "Denied"));
    await f.resource.save([]);
    assert.equal(f.denied(), 1);
    assert.equal(f.resource.snapshot().closed, true);
    assert.equal(f.resource.snapshot().value, null);
  }
});

test("invalid checklist edits never reach transport and an inaccessible step clears stale entries without ending the account session", async () => {
  let gets = 0,
    writes = 0,
    denied = 0;
  const value: PlanChecklist = {
    userId: "101",
    itemId: "20",
    revision: 1,
    entries: [],
  };
  const resource = createPlanChecklistResource({
    userId: "101",
    itemId: "20",
    sessionSignal: new AbortController().signal,
    publish: () => {},
    onAccessDenied: () => denied++,
    onSaved: () => {},
    client: {
      get: async () => {
        if (gets++) throw new ApiError(404, "Missing");
        return value;
      },
      save: async () => {
        writes++;
        return value;
      },
    },
  });
  await resource.load();
  assert.equal(
    await resource.save([
      { id: randomUUID(), title: "bad\0input", details: "", completed: false },
    ]),
    false,
  );
  assert.equal(writes, 0);
  await resource.load();
  assert.equal(resource.snapshot().value, null);
  assert.equal(resource.snapshot().needsRefresh, true);
  assert.equal(denied, 0);
  resource.dispose();
});

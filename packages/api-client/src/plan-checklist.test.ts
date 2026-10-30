import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient, ApiError } from "./index.js";
import { createPlanChecklistResource } from "./plan-checklist-resource.js";
import type { PlanChecklistEntry } from "@citygo/contracts";
test("checklist receipts must match the full normalized submitted snapshot, never just a matching parent revision", async () => {
  const entries: PlanChecklistEntry[] = [
    {
      id: randomUUID(),
      title: "Платежи",
      details: "Уточнить сумму",
      completed: false,
    },
    { id: randomUUID(), title: "Документы", details: "", completed: false },
  ];
  for (const changed of [
    [{ ...entries[0]!, title: "Подмена" }, entries[1]!],
    [{ ...entries[0]!, completed: true }, entries[1]!],
    [...entries].reverse(),
    entries.slice(1),
  ]) {
    const response = {
      userId: "101",
      itemId: "20",
      revision: 2,
      entries: changed,
    };
    const client = createClient("http://synthetic", {
      fetch: async () => Response.json(response),
    });
    await assert.rejects(
      client.savePlanChecklist("20", { expectedRevision: 1, entries }),
      (cause) => cause instanceof ApiError && cause.code === "invalid_response",
    );
    let saved = 0;
    const resource = createPlanChecklistResource({
      userId: "101",
      itemId: "20",
      sessionSignal: new AbortController().signal,
      publish: () => {},
      onSaved: () => saved++,
      onAccessDenied: () => assert.fail("same owner"),
      client: {
        get: async () => ({ ...response, revision: 1, entries: [] }),
        save: async () => response,
      },
    });
    await resource.load();
    assert.equal(await resource.save(entries), false);
    assert.equal(saved, 0);
    assert.equal(resource.snapshot().needsRefresh, true);
    assert.deepEqual(resource.snapshot().value!.entries, []);
    resource.dispose();
  }
});

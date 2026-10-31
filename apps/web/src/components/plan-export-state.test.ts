import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlanExportAction,
  planExportText,
  type PlanExportState,
} from "./plan-export-state";
import type { PersonalPlanExport } from "@citygo/contracts";
const value: PersonalPlanExport = {
  userId: "1",
  generatedAt: "2026-10-31T12:00:00Z",
  items: [
    {
      id: "9007199254740993",
      title: "Москва 😀",
      details: "Полный текст\n<script>не HTML</script>",
      revision: 1,
      status: "completed",
      source: { threadId: "11", messageId: "12", role: "assistant" },
      createdAt: "2026-10-31T12:00:00Z",
      updatedAt: "2026-10-31T12:00:00Z",
      checklist: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Проверить район",
          details: "Точное описание",
          completed: false,
        },
      ],
    },
  ],
};
test("whole plan export text preserves full personal text, statuses and checklists without technical source IDs", () => {
  const text = planExportText(value);
  assert.match(text, /1\. \[x\] Москва 😀/);
  assert.match(text, /\[ \] Проверить район/);
  assert.ok(text.includes(value.items[0]!.details));
  assert.ok(text.includes("Точное описание"));
  assert.ok(!text.includes("9007199254740993"));
});
test("export starts only explicitly, suppresses concurrent clicks and late cancellation/logout downloads", async () => {
  for (const reason of ["cancel", "logout", "dispose"]) {
    let resolve!: (v: PersonalPlanExport) => void;
    let calls = 0,
      downloads = 0;
    const session = new AbortController();
    const action = createPlanExportAction({
      userId: "1",
      signal: session.signal,
      read: () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      },
      download: () => downloads++,
      publish: () => {},
      onAccessDenied: () => assert.fail(),
    });
    assert.equal(calls, 0);
    const pending = action.run();
    await action.run();
    assert.equal(calls, 1);
    if (reason === "cancel") action.cancel();
    else if (reason === "logout") session.abort();
    else action.dispose();
    resolve(value);
    await pending;
    assert.equal(downloads, 0);
    action.dispose();
  }
});
test("foreign export closes access; failed export keeps a generic retryable error without raw contents", async () => {
  let denied = 0,
    downloads = 0;
  const session = new AbortController();
  let states: PlanExportState[] = [];
  const action = createPlanExportAction({
    userId: "2",
    signal: session.signal,
    read: async () => value,
    download: () => downloads++,
    publish: (s) => states.push(s),
    onAccessDenied: () => denied++,
  });
  await action.run();
  assert.equal(denied, 1);
  assert.equal(downloads, 0);
  action.dispose();
  states = [];
  const failing = createPlanExportAction({
    userId: "1",
    signal: session.signal,
    read: async () => {
      throw new Error("PRIVATE");
    },
    download: () => assert.fail(),
    publish: (s) => states.push(s),
    onAccessDenied: () => assert.fail(),
  });
  await failing.run();
  assert.ok(states.at(-1)!.error);
  assert.ok(!JSON.stringify(states).includes("PRIVATE"));
  failing.dispose();
});

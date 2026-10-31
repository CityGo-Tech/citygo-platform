import assert from "node:assert/strict";
import test from "node:test";
import { personalPlanExportSchema } from "./personal-plan-export.js";
const stamp = "2026-10-31T12:00:00Z";
const item = (id = "9007199254740993") => ({
  id,
  title: "Переезд",
  details: "Полное описание",
  status: "pending",
  revision: 1,
  source: null,
  createdAt: stamp,
  updatedAt: stamp,
  checklist: [],
});
test("whole plan export is strict, ordered and bounded across all steps and checklist text", () => {
  const value = { userId: "1", generatedAt: stamp, items: [item()] };
  assert.deepEqual(personalPlanExportSchema.parse(value), value);
  assert.equal(
    personalPlanExportSchema.safeParse({ ...value, items: [] }).success,
    true,
  );
  for (const change of [
    { extra: true },
    { items: [{ ...item(), details: "bad\0text" }] },
    { items: [{ ...item(), title: "bad\ud800text" }] },
    { userId: "01" },
    { generatedAt: "now" },
    { items: [item(), item()] },
    { items: [item("1"), item("2")] },
    {
      items: [
        {
          ...item(),
          checklist: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "Пункт",
              details: "",
              completed: "yes",
            },
          ],
        },
      ],
    },
    { items: Array.from({ length: 201 }, (_, n) => item(String(1000 - n))) },
  ])
    assert.equal(
      personalPlanExportSchema.safeParse({ ...value, ...change }).success,
      false,
    );
  const large = Array.from({ length: 200 }, (_, n) => ({
    ...item(String(1000 - n)),
    details: "я".repeat(4000),
    checklist: Array.from({ length: 20 }, (_, c) => ({
      id: "11111111-1111-4111-8111-" + String(c).padStart(12, "0"),
      title: "Пункт",
      details: "я".repeat(1000),
      completed: false,
    })),
  }));
  assert.equal(
    personalPlanExportSchema.safeParse({ ...value, items: large }).success,
    false,
  );
});

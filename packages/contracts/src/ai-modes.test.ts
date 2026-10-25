import assert from "node:assert/strict";
import test from "node:test";
import { aiModeIds, aiModeLabels, aiModesSchema } from "./ai-modes.js";
import { chatInputSchema } from "./platform.js";
import { dashboardResponseSchema } from "./responses.js";

const modes = {
  catalogId: "a".repeat(64),
  defaultMode: "balanced",
  options: aiModeIds.map((id) => ({
    id,
    label: aiModeLabels[id],
    available: true,
  })),
};
test("public mode capability has exactly three opaque choices and a balanced default", () => {
  assert.deepEqual(aiModesSchema.parse(modes), modes);
  for (const value of [
    { ...modes, defaultMode: "maximum" },
    { ...modes, catalogId: "old-catalog" },
    { ...modes, provider: "forged" },
    { ...modes, options: modes.options.slice(1) },
    {
      ...modes,
      options: [modes.options[0], modes.options[0], modes.options[2]],
    },
    {
      ...modes,
      options: modes.options.map((option) => ({ ...option, model: "forged" })),
    },
    {
      ...modes,
      options: modes.options.map((option) => ({
        ...option,
        label: "private model",
      })),
    },
    {
      ...modes,
      options: [
        { id: "private-model", label: "Баланс", available: true },
        ...modes.options.slice(1),
      ],
    },
  ])
    assert.equal(aiModesSchema.safeParse(value).success, false);
});

test("chat mode is paired with its exact catalog while legacy requests remain valid", () => {
  const legacy = {
    text: "Последний вопрос",
    requestId: "1bfd589c-657a-446b-8a22-0ecfa1ec416f",
  };
  assert.deepEqual(chatInputSchema.parse(legacy), legacy);
  for (const aiMode of aiModeIds) {
    const request = { ...legacy, aiMode, aiModeCatalogId: modes.catalogId };
    assert.deepEqual(chatInputSchema.parse(request), request);
  }
  for (const fields of [
    { aiMode: "maximum" },
    { aiModeCatalogId: modes.catalogId },
    { aiMode: "forged", aiModeCatalogId: modes.catalogId },
    { aiMode: "balanced", aiModeCatalogId: "invalid" },
    { aiMode: null, aiModeCatalogId: modes.catalogId },
  ])
    assert.equal(
      chatInputSchema.safeParse({ ...legacy, ...fields }).success,
      false,
    );
});

test("dashboard mode capability is additive but known malformed choices fail closed", () => {
  const board = {
    user: { id: "1", email: "synthetic@example.test" },
    profile: null,
    xp: 0,
    quests: [],
    thread: null,
    provider: "unconfigured",
    aiAccess: { policy: null, granted: false, dailyLimit: 0 },
  };
  assert.equal(dashboardResponseSchema.safeParse(board).success, true);
  assert.equal(
    dashboardResponseSchema.safeParse({
      ...board,
      aiAccess: { ...board.aiAccess, modes },
    }).success,
    true,
  );
  assert.equal(
    dashboardResponseSchema.safeParse({
      ...board,
      aiAccess: { ...board.aiAccess, modes: { ...modes, options: [] } },
    }).success,
    false,
  );
});

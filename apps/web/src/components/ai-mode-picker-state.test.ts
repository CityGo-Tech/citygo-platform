import assert from "node:assert/strict";
import test from "node:test";
import { aiModeIds, aiModeLabels, type AiModes } from "@citygo/contracts";
import { aiModeDescriptions, selectableAiMode } from "./ai-mode-picker-state";

const modes: AiModes = {
  catalogId: "b".repeat(64),
  defaultMode: "balanced",
  options: aiModeIds.map((id) => ({
    id,
    label: aiModeLabels[id],
    available: id !== "minimum",
    consentRequired: id === "maximum",
  })),
};

test("picker exposes only the three task descriptions with the explicit Minimum product name", () => {
  assert.deepEqual(aiModeDescriptions, {
    maximum: "Сложные вопросы и подробный разбор вариантов.",
    balanced: "Повседневные вопросы и планирование переезда.",
    minimum: "Простые вопросы и первые шаги.",
  });
  assert.doesNotMatch(
    JSON.stringify(aiModeDescriptions),
    /RouterAI|OpenAI|DeepSeek|GigaChat|резерв|×10|₽|Базовый/i,
  );
});

test("intent requires an advertised available mode and idle state, without picking a fallback or granting consent", () => {
  const before = JSON.stringify(modes);
  assert.equal(selectableAiMode(modes, "maximum", false), true);
  assert.equal(selectableAiMode(modes, "balanced", false), true);
  assert.equal(selectableAiMode(modes, "minimum", false), false);
  assert.equal(selectableAiMode(modes, "maximum", true), false);
  assert.equal(selectableAiMode(undefined, "maximum", false), false);
  assert.equal(selectableAiMode(modes, "synthetic-unknown", false), false);
  assert.equal(selectableAiMode(modes, { id: "maximum" }, false), false);
  assert.equal(JSON.stringify(modes), before);
  assert.equal(modes.options[0]!.consentRequired, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aiModeIds,
  aiModeLabels,
  type AiModeId,
  type AiModes,
} from "@citygo/contracts";

// Node checks semantic markup; browser tests load the real CSS and verify layout.
const cssHook = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".module.css"))
      return {
        format: "module",
        source: "export default {}",
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
const { AiModeSelector } = await import("./ai-mode-selector");
cssHook.deregister();

const modes: AiModes = {
  catalogId: "a".repeat(64),
  defaultMode: "balanced",
  options: aiModeIds.map((id) => ({
    id,
    label: aiModeLabels[id],
    available: id !== "minimum",
  })),
};
const render = (
  catalog: AiModes | undefined,
  disabled = false,
  selected: AiModeId = "balanced",
) =>
  renderToStaticMarkup(
    createElement(AiModeSelector, {
      modes: catalog,
      selected,
      disabled,
      onSelect() {
        assert.fail("Rendering must not select, grant or send");
      },
    }),
  );

test("legacy server has no picker; public trigger and task cards do not expose providers or financial internals", () => {
  assert.equal(render(undefined), "");
  const html = render(modes);
  assert.match(html, /aria-label="Режим работы"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-ai-mode="balanced"/);
  assert.match(html, /aria-label="Баланс" aria-pressed="true"/);
  assert.match(
    html,
    /aria-label="Минимум" aria-pressed="false"[^>]*disabled=""/,
  );
  assert.match(html, /Повседневные вопросы и планирование переезда/);
  assert.doesNotMatch(
    html,
    /RouterAI|OpenAI|DeepSeek|GigaChat|резерв|×10|catalogId|[a-f0-9]{64}|за запрос/i,
  );
  assert.match(render(modes, true), /data-ai-mode="balanced" disabled=""/);
});

test("Minimum keeps only its product name and description without changing or disclosing fixed-price metadata", () => {
  const catalog: AiModes = {
    ...modes,
    options: modes.options.map((option) =>
      option.id === "minimum"
        ? {
            ...option,
            price: { kind: "fixed", currency: "RUB", amountMicros: 3_000_000 },
          }
        : option,
    ),
  };
  const before = JSON.stringify(catalog);
  const html = render(catalog);
  assert.match(html, /aria-label="Минимум"/);
  assert.match(html, /Простые вопросы и первые шаги/);
  assert.doesNotMatch(html, /amountMicros|fixed|RUB|3 ₽|Базовый/);
  assert.equal(JSON.stringify(catalog), before);
});

test("an initial consent-required choice is still visible and is not silently replaced by an available legacy mode", () => {
  const catalog: AiModes = {
    ...modes,
    options: modes.options.map((option) => ({
      ...option,
      consentRequired: option.id === "maximum",
    })),
  };
  const html = render(catalog, false, "maximum");
  assert.match(html, /data-ai-mode="maximum"/);
  assert.match(html, /aria-label="Максимум" aria-pressed="true"/);
  assert.doesNotMatch(html, /<input[^>]*checkbox/);
  assert.equal(catalog.options[0]!.consentRequired, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { aiModeIds, aiModeLabels, type AiModes } from "@citygo/contracts";
import { AiModeSelector } from "./ai-mode-selector";
const modes: AiModes = {
  catalogId: "a".repeat(64),
  defaultMode: "balanced",
  options: aiModeIds.map((id) => ({
    id,
    label: aiModeLabels[id],
    available: id !== "minimum",
  })),
};
const render = (catalog: AiModes | undefined, disabled = false) =>
  renderToStaticMarkup(
    createElement(AiModeSelector, {
      modes: catalog,
      selected: "balanced",
      disabled,
      onSelect() {
        assert.fail("Rendering must not select or send");
      },
    }),
  );
test("legacy server has no selector; the new selector shows only public names and explicit unavailable choices", () => {
  assert.equal(render(undefined), "");
  const html = render(modes);
  assert.match(html, /Режим работы/);
  assert.match(html, /value="balanced" selected=""/);
  assert.match(html, /value="minimum" disabled=""/);
  assert.match(html, /Максимум/);
  assert.match(html, /Баланс/);
  assert.match(html, /Минимум/);
  assert.doesNotMatch(html, /за запрос/);
  assert.doesNotMatch(
    html,
    /RouterAI|OpenAI|DeepSeek|GigaChat|резерв|×10|catalogId|[a-f0-9]{64}/i,
  );
  assert.match(render(modes, true), /<select[^>]*disabled=""/);
});

test("Minimum keeps only its name without changing its price, ID or availability", () => {
  const catalog: AiModes = {
    ...modes,
    options: modes.options.map((option) =>
      option.id === "minimum"
        ? {
            ...option,
            price: {
              kind: "fixed",
              currency: "RUB",
              amountMicros: 3_000_000,
            },
          }
        : option,
    ),
  };
  const html = render(catalog);
  assert.match(
    html,
    /value="minimum" disabled="">Минимум — временно недоступен<\/option>/,
  );
  assert.match(html, /value="maximum">Максимум<\/option>/);
  assert.match(html, /value="balanced" selected="">Баланс<\/option>/);
  assert.doesNotMatch(
    html,
    /amountMicros|fixed|RUB|RouterAI|GigaChat|резерв|×10|за запрос|3 ₽/i,
  );
  assert.match(render(catalog, true), /<select[^>]*disabled=""/);
});

test("the initially selected mode can explicitly request consent without a switch or an automatic grant", () => {
  const catalog: AiModes = {
    ...modes,
    options: modes.options.map((option) => ({
      ...option,
      consentRequired: option.id === "balanced",
    })),
  };
  assert.match(
    render(catalog),
    /<button[^>]*type="button"[^>]*>Подтвердить выбор<\/button>/,
  );
  assert.match(render(catalog, true), /<button[^>]*disabled=""/);
});

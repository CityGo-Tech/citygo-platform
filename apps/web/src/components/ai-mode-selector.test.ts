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
  assert.match(html, /Режим ответа/);
  assert.match(html, /value="balanced" selected=""/);
  assert.match(html, /value="minimum" disabled=""/);
  assert.match(html, /Максимум/);
  assert.match(html, /Баланс/);
  assert.match(html, /Минимум/);
  assert.doesNotMatch(
    html,
    /RouterAI|OpenAI|DeepSeek|GigaChat|резерв|×10|catalogId|[a-f0-9]{64}/i,
  );
  assert.match(render(modes, true), /<select[^>]*disabled=""/);
});

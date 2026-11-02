import assert from "node:assert/strict";
import test from "node:test";
import { aiModesSchema } from "@citygo/contracts";
import { captureAiModeSelection, isAiModeAvailable } from "@citygo/api-client";
import { initialWebAiMode } from "./ai-mode-preference";

test("Maximum is the Web preference without changing the strict catalog consumed by installed clients", () => {
  const catalog = aiModesSchema.parse({
    catalogId: "a".repeat(64),
    defaultMode: "balanced",
    options: [
      { id: "maximum", label: "Максимум", available: true },
      { id: "balanced", label: "Баланс", available: true },
      { id: "minimum", label: "Минимум", available: false },
    ],
  });
  assert.equal(initialWebAiMode, "maximum");
  assert.equal(catalog.defaultMode, "balanced");
  assert.deepEqual(captureAiModeSelection(catalog, initialWebAiMode), {
    aiMode: "maximum",
    aiModeCatalogId: catalog.catalogId,
  });
  // An explicit choice remains explicit; receiving a catalog cannot reset it.
  assert.deepEqual(captureAiModeSelection(catalog, "balanced"), {
    aiMode: "balanced",
    aiModeCatalogId: catalog.catalogId,
  });
  catalog.options[0]!.consentRequired = true;
  assert.equal(isAiModeAvailable(catalog, initialWebAiMode, true), false);
  assert.throws(() => captureAiModeSelection(catalog, initialWebAiMode));
  catalog.options[0]!.available = false;
  assert.equal(isAiModeAvailable(catalog, initialWebAiMode, true), false);
  assert.throws(() => captureAiModeSelection(catalog, initialWebAiMode));
  assert.equal(captureAiModeSelection(undefined, initialWebAiMode), undefined);
});

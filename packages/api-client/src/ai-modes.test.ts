import assert from "node:assert/strict";
import test from "node:test";
import { aiModeIds, aiModeLabels, type AiModes } from "@citygo/contracts";
import {
  createClient,
  captureAiModeSelection,
  aiModeUnavailableMessage,
  isAiModeAvailable,
  formatAiModeOptionLabel,
} from "./index.js";
const modes = (): AiModes => ({
  catalogId: "a".repeat(64),
  defaultMode: "balanced",
  options: aiModeIds.map((id) => ({
    id,
    label: aiModeLabels[id],
    available: true,
  })),
});

test("public fixed-price text is optional and remains outside the captured request", () => {
  const catalog = modes();
  const minimum = catalog.options.find((option) => option.id === "minimum")!;
  assert.equal(formatAiModeOptionLabel(minimum), "Минимум");
  minimum.price = { kind: "fixed", currency: "RUB", amountMicros: 3_000_000 };
  assert.equal(formatAiModeOptionLabel(minimum), "Минимум · 3 ₽ за запрос");
  assert.equal(formatAiModeOptionLabel(catalog.options[0]!), "Максимум");
  assert.deepEqual(captureAiModeSelection(catalog, "minimum"), {
    aiMode: "minimum",
    aiModeCatalogId: "a".repeat(64),
  });
});

test("submission captures an independent mode capability and never chooses a fallback", () => {
  assert.equal(captureAiModeSelection(undefined, "maximum"), undefined);
  const catalog = modes(),
    captured = captureAiModeSelection(catalog, "maximum");
  catalog.catalogId = "b".repeat(64);
  catalog.options[0]!.available = false;
  assert.deepEqual(captured, {
    aiMode: "maximum",
    aiModeCatalogId: "a".repeat(64),
  });
  assert.throws(() => captureAiModeSelection(catalog, "maximum"), {
    message: aiModeUnavailableMessage,
  });
  assert.deepEqual(captureAiModeSelection(catalog, "balanced"), {
    aiMode: "balanced",
    aiModeCatalogId: "b".repeat(64),
  });
});

test("mode availability uses the selected advertised option while legacy retains its old gate", () => {
  const catalog = modes();
  catalog.options.find((option) => option.id === "balanced")!.available = false;
  assert.equal(isAiModeAvailable(catalog, "maximum", false), true);
  assert.equal(isAiModeAvailable(catalog, "balanced", true), false);
  assert.equal(isAiModeAvailable(undefined, "balanced", true), true);
  assert.equal(isAiModeAvailable(undefined, "maximum", false), false);
});

test("stream sends one frozen mode selection with fixed5 and no mutation or automatic error replay", async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (_url, init) => {
      calls++;
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        { error: "Режим сейчас недоступен" },
        { status: 409 },
      );
    },
  });
  const catalog = modes();
  catalog.options.find((option) => option.id === "minimum")!.price = {
    kind: "fixed",
    currency: "RUB",
    amountMicros: 3_000_000,
  };
  const selection = captureAiModeSelection(catalog, "minimum")!;
  const pending = client.stream(
    "1",
    "Последний вопрос",
    "request-once",
    () => assert.fail("No stream events on refusal"),
    undefined,
    "c".repeat(64),
    "fixed5_overdraft",
    selection,
  );
  selection.aiMode = "maximum";
  await assert.rejects(pending, /Режим сейчас недоступен/);
  assert.equal(calls, 1);
  assert.deepEqual(bodies, [
    {
      text: "Последний вопрос",
      requestId: "request-once",
      policyId: "c".repeat(64),
      creditReservationMode: "fixed5_overdraft",
      aiMode: "minimum",
      aiModeCatalogId: "a".repeat(64),
    },
  ]);
});

test("invalid stream selection is rejected before fetch and legacy bodies gain no mode fields", async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const client = createClient("http://synthetic", {
    fetch: async (_url, init) => {
      calls++;
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('data: {"type":"done","messageId":"1"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  await assert.rejects(
    client.stream(
      "1",
      "text",
      "request",
      () => {},
      undefined,
      undefined,
      undefined,
      { aiMode: "balanced", aiModeCatalogId: "invalid" },
    ),
  );
  assert.equal(calls, 0);
  await client.stream("1", "text", "request", () => {});
  assert.deepEqual(bodies, [{ text: "text", requestId: "request" }]);
});

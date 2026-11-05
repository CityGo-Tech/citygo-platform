import assert from "node:assert/strict";
import test from "node:test";
import type { Message, WebSources } from "@citygo/contracts";
import { createSessionGuard } from "@citygo/api-client";
import {
  mobileMessageSources,
  openMobileMessageSource,
} from "./message-sources-state.js";

function message(): Message {
  return {
    id: "12",
    role: "assistant",
    status: "complete",
    agentKey: "housing",
    content: "Сохранённый ответ с источниками.",
    generation: {
      provider: "routerai",
      requestedModel: "openai/gpt-6.1-sol",
      model: "openai/gpt-6.1-sol",
      webSources: {
        version: "routerai_native_v1",
        citations: [
          { url: "https://example.com/housing", title: "Источник 🏠" },
        ],
      },
    },
  };
}

test("native saved-answer readback preserves sources only for complete assistant messages and copies nested data", () => {
  const saved: Message = JSON.parse(JSON.stringify(message()));
  const sources = mobileMessageSources(saved);
  assert.deepEqual(sources, message().generation!.webSources!.citations);
  sources[0]!.title = "Локальная правка";
  assert.equal(
    saved.generation!.webSources!.citations[0]!.title,
    "Источник 🏠",
  );
  assert.deepEqual(
    mobileMessageSources({ ...saved, status: "interrupted" }),
    [],
  );
  assert.deepEqual(mobileMessageSources({ ...saved, role: "user" }), []);
  assert.deepEqual(
    mobileMessageSources({ ...saved, generation: undefined }),
    [],
  );
  const forged = message();
  forged.generation!.webSources = {
    version: "model_markdown",
    citations: [],
  } as unknown as WebSources;
  assert.deepEqual(mobileMessageSources(forged), []);
  const unsafe = message();
  unsafe.generation!.webSources!.citations[0]!.url =
    "https://127.0.0.1/private";
  assert.deepEqual(mobileMessageSources(unsafe), []);
});

test("native sources open only after explicit valid selection in the current account lifetime", async () => {
  const guard = createSessionGuard();
  const ticket = guard.capture();
  const calls: string[] = [];
  const open = async (url: string) => {
    calls.push(url);
  };
  const saved = message();
  mobileMessageSources(saved);
  assert.deepEqual(calls, []);
  for (const index of [-1, 0.5, 1, NaN])
    assert.equal(
      await openMobileMessageSource(saved, index, ticket, open),
      false,
    );
  assert.deepEqual(calls, []);
  assert.equal(await openMobileMessageSource(saved, 0, ticket, open), true);
  assert.deepEqual(calls, ["https://example.com/housing"]);
  guard.reset("another-owner");
  assert.equal(await openMobileMessageSource(saved, 0, ticket, open), false);
  assert.equal(calls.length, 1);
  assert.equal(
    await openMobileMessageSource(
      { ...saved, status: "interrupted" },
      0,
      guard.capture(),
      open,
    ),
    false,
  );
  assert.equal(calls.length, 1);
});

test("a delayed source-opening error cannot leak old destination details or update the replacement owner", async () => {
  const guard = createSessionGuard();
  let reject!: (error: Error) => void;
  const pending = openMobileMessageSource(
    message(),
    0,
    guard.capture(),
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  guard.reset("new-owner");
  reject(new Error("PRIVATE_DESTINATION"));
  assert.equal(await pending, false);
  let calls = 0;
  await assert.rejects(
    openMobileMessageSource(message(), 0, guard.capture(), async () => {
      calls++;
      throw new Error("PRIVATE_DESTINATION");
    }),
    (error) =>
      error instanceof Error &&
      error.message === "Не удалось открыть источник. Повторите попытку.",
  );
  assert.equal(calls, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readChatCompletion } from "./chat-completion.js";
import type { ModelStreamEvent } from "./provider.js";

const signal = () => new AbortController().signal;
const quality = {
  maxOutputCharacters: 128000,
  maxStreamBytes: 16 * 1024 * 1024,
};
function chunk(content: string, stopped = false) {
  return {
    model: "synthetic-model",
    choices: [
      { index: 0, delta: { content }, finish_reason: stopped ? "stop" : null },
    ],
  };
}
function body(events: unknown[]) {
  return new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
      "data: [DONE]\n\n",
  ).body!;
}
async function collect(input: AsyncIterable<ModelStreamEvent>) {
  const result: ModelStreamEvent[] = [];
  for await (const value of input) result.push(value);
  return result;
}

test("Chat Completions retains default 24000 characters and allows an explicit finite quality bound", async () => {
  const events = [chunk("x".repeat(24001)), chunk("", true)];
  await assert.rejects(collect(readChatCompletion(body(events), signal())), {
    message: "Chat Completions output too long",
  });
  const result = await collect(
    readChatCompletion(body(events), signal(), quality),
  );
  assert.deepEqual(result[0], { type: "delta", text: "x".repeat(24001) });
  assert.deepEqual(result.at(-1), {
    type: "complete",
    model: "synthetic-model",
  });
});

test("quality bound accepts 128000 characters across frames and rejects one extra", async () => {
  const events = Array.from({ length: 4 }, () => chunk("x".repeat(32000)));
  const result = await collect(
    readChatCompletion(body([...events, chunk("", true)]), signal(), quality),
  );
  assert.equal(result.filter((event) => event.type === "delta").length, 4);
  assert.equal(result.at(-1)?.type, "complete");
  await assert.rejects(
    collect(
      readChatCompletion(
        body([...events, chunk("x"), chunk("", true)]),
        signal(),
        quality,
      ),
    ),
    { message: "Chat Completions output too long" },
  );
});

test("quality parser accepts realistic JSON framing above 1 MiB without losing terminal usage", async () => {
  const events: unknown[] = Array.from({ length: 6000 }, () => ({
    ...chunk("abc"),
    id: "x".repeat(100),
  }));
  events.push(chunk("", true));
  const usage = {
    model: "synthetic-model",
    choices: [],
    usage: { prompt_tokens: 1024, completion_tokens: 6000 },
  };
  const result = await collect(
    readChatCompletion(body([...events, usage]), signal(), quality),
  );
  assert.deepEqual(result.at(-1), {
    type: "complete",
    model: "synthetic-model",
    usage: { inputTokens: 1024, outputTokens: 6000 },
  });
  assert.equal(result.filter((event) => event.type === "delta").length, 6000);
  await assert.rejects(
    collect(readChatCompletion(body([...events, usage]), signal())),
    {
      message: "SSE response too large",
    },
  );
});

test("invalid output bounds cannot remove the safety ceiling", async () => {
  for (const maxOutputCharacters of [0, -1, 1.5, NaN, Infinity, 128001])
    await assert.rejects(
      collect(
        readChatCompletion(body([chunk("ok", true)]), signal(), {
          maxOutputCharacters,
        }),
      ),
      { message: "Invalid Chat Completions output limit" },
    );
});

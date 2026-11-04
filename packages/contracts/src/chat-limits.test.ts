import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_MAX_CHARACTERS,
  CHAT_MAX_UTF16_UNITS,
  chatCharacterCount,
  chatMessageTextSchema,
  chatTextProblem,
  chatTextSchema,
} from "./chat-limits.js";
import { chatInputSchema } from "./platform.js";
import { assistantContextInputSchema } from "./assistant-context.js";

test("100000 Unicode code points are accepted consistently by chat and draft preview", () => {
  for (const text of [
    "я".repeat(CHAT_MAX_CHARACTERS),
    "😀".repeat(CHAT_MAX_CHARACTERS),
  ]) {
    assert.equal(chatCharacterCount(text), CHAT_MAX_CHARACTERS);
    assert.equal(chatTextProblem(text), null);
    assert.equal(chatMessageTextSchema.parse(text), text);
    assert.equal(
      chatInputSchema.parse({
        text,
        requestId: "2eec96dc-b104-4d82-a880-04a397a61d8d",
      }).text,
      text,
    );
    assert.equal(
      assistantContextInputSchema.parse({ threadId: null, draft: text }).draft,
      text,
    );
    for (const schema of [chatTextSchema, chatMessageTextSchema])
      assert.equal(schema.safeParse(text + "a").success, false);
  }
  assert.equal(chatCharacterCount("😀ёe\u0301"), 4);
  assert.equal(chatCharacterCount("👨‍👩‍👦"), 5);
});

test("corrupt Unicode and UTF16 oversize input fail without changing text or inventing replacements", () => {
  for (const text of ["a\ud800", "\udfffz", "\ud800\ud800", "\udfff\udfff"])
    assert.equal(chatTextProblem(text), "invalid_unicode");
  assert.equal(chatTextProblem("a\0b"), "invalid_character");
  assert.equal(chatTextProblem("a\t\n\rb\u0001"), null);
  assert.equal(
    chatTextProblem("a".repeat(CHAT_MAX_UTF16_UNITS + 1)),
    "too_long",
  );
  assert.equal(
    chatTextProblem("😀".repeat(CHAT_MAX_CHARACTERS + 1)),
    "too_long",
  );
  assert.equal(chatTextSchema.parse("  \n"), "  \n");
  assert.equal(chatMessageTextSchema.safeParse("  \n").success, false);
  assert.equal(chatMessageTextSchema.parse("  Вопрос 🧳  "), "Вопрос 🧳");
});

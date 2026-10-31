import assert from "node:assert/strict";
import test from "node:test";
import type { Dashboard } from "@citygo/contracts";
import {
  assistantHandoffDraft,
  assistantHandoffTarget,
  currentAssistantHandoffSource,
  type AssistantHandoffSource,
} from "./assistant-handoff-state";

const fixture = () => {
  const controller = new AbortController();
  const source: AssistantHandoffSource = {
    userId: "101",
    threadId: "9007199254740993",
    messageId: "9007199254740995",
    assistantKey: "housing",
    content: "Мой подтверждённый фрагмент 🧳",
    sessionSignal: controller.signal,
  };
  const board = {
    user: { id: source.userId },
    thread: {
      id: source.threadId,
      agentKey: "housing",
      assistantKey: "housing",
      messages: [
        {
          id: source.messageId,
          role: "assistant",
          content: source.content,
          status: "complete",
          agentKey: "housing",
        },
      ],
    },
  } as Dashboard;
  return { controller, source, board };
};

test("handoff binds exact completed message, bigint IDs, owner, helper and live session", () => {
  const f = fixture();
  assert.equal(
    currentAssistantHandoffSource(f.source, f.board, f.controller.signal),
    true,
  );
  for (const source of [
    { ...f.source, userId: "102" },
    { ...f.source, threadId: "9007199254740994" },
    { ...f.source, messageId: "9007199254740996" },
    { ...f.source, content: "Другой текст" },
    { ...f.source, assistantKey: "support" as const },
    { ...f.source, sessionSignal: new AbortController().signal },
  ])
    assert.equal(
      currentAssistantHandoffSource(source, f.board, f.controller.signal),
      false,
    );
  f.board.thread!.messages[0]!.status = "interrupted";
  assert.equal(
    currentAssistantHandoffSource(f.source, f.board, f.controller.signal),
    false,
  );
  f.board.thread!.messages[0]!.status = "complete";
  f.controller.abort();
  assert.equal(
    currentAssistantHandoffSource(f.source, f.board, f.controller.signal),
    false,
  );
});

test("only another known CityGo helper is a target", () => {
  const { source } = fixture();
  assert.equal(assistantHandoffTarget(source, "resume-builder"), true);
  assert.equal(assistantHandoffTarget(source, "support"), true);
  for (const key of ["housing", "bubble", "admin", "", "Housing", "__proto__"])
    assert.equal(assistantHandoffTarget(source, key), false);
});

test("reviewed text appends once without replacing or normalizing the existing draft", () => {
  const existing = "  Мой черновик\nсо строками  ";
  assert.equal(
    assistantHandoffDraft("  Фрагмент 🧳\nвторая строка  ", existing),
    existing + "\n\nФрагмент 🧳\nвторая строка",
  );
  assert.equal(
    assistantHandoffDraft("<script>plain text</script>"),
    "<script>plain text</script>",
  );
  assert.equal(assistantHandoffDraft("😀".repeat(2000)).length, 4000);
  assert.equal(assistantHandoffDraft("x", "y".repeat(3997)).length, 4000);
  for (const [text, draft] of [
    [" ", ""],
    ["x".repeat(4001), ""],
    ["😀".repeat(2001), ""],
    ["x", "y".repeat(3998)],
  ])
    assert.throws(() => assistantHandoffDraft(text!, draft!));
});

test("invalid control and isolated surrogate content cannot become a handoff prompt", () => {
  for (const text of [
    "x\u0000y",
    "x\u0007y",
    "x\u007fy",
    "x\ud800y",
    "x\udfffy",
  ])
    assert.throws(() => assistantHandoffDraft(text));
  assert.equal(
    assistantHandoffDraft("Списки:\n1. Дом\t2. Работа\r\n🧳"),
    "Списки:\n1. Дом\t2. Работа\r\n🧳",
  );
});

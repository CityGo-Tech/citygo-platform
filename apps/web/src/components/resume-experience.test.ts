import assert from "node:assert/strict";
import test from "node:test";
import type { Dashboard } from "@citygo/contracts";
import {
  assistantHandoffTarget,
  currentAssistantHandoffSource,
  type AssistantHandoffSource,
} from "./assistant-handoff-state";
import {
  emptyResumeExperience,
  reviewedResumeText,
  type ResumeExperience,
} from "./resume-experience";

function resume(overrides: Partial<ResumeExperience> = {}) {
  return { ...emptyResumeExperience, ...overrides };
}

test("resume preview contains only the entered details in their named sections", () => {
  const provided = resume({
    goal: "  Анализ данных ",
    employer: "АО «Учебный проект»",
    role: "  Стажёр  ",
    experience: " Проверял записи\nи готовил отчёт 📊  ",
    skills: " SQL, таблицы ",
  });

  assert.equal(
    reviewedResumeText(provided),
    [
      "Цель: Анализ данных",
      "Работодатель: АО «Учебный проект»",
      "Должность: Стажёр",
      "Опыт: Проверял записи\nи готовил отчёт 📊",
      "Навыки: SQL, таблицы",
    ].join("\n\n"),
  );
});

test("an incomplete account of experience is valid and a correction removes the old fact", () => {
  const before = resume({
    goal: "Развитие в аналитике",
    experience: "Готовил отчёты для команды",
  });
  assert.equal(
    reviewedResumeText(before),
    "Цель: Развитие в аналитике\n\nОпыт: Готовил отчёты для команды",
  );

  const corrected = { ...before, experience: "Проверял исходные данные" };
  assert.equal(
    reviewedResumeText(corrected),
    "Цель: Развитие в аналитике\n\nОпыт: Проверял исходные данные",
  );
  assert.equal(reviewedResumeText(resume({ skills: "SQL" })), "Навыки: SQL");
});

test("an empty or goal-only form cannot be handed off as confirmed experience", () => {
  assert.equal(reviewedResumeText(resume()), null);
  assert.equal(
    reviewedResumeText(
      resume({ goal: "Хочу возглавить команду", experience: " \n\t " }),
    ),
    null,
  );
});

test("invalid text and an oversized combined result are not transferred or truncated", () => {
  for (const invalid of ["a\u0000b", "a\u0007b", "a\u007fb", "a\ud800b"]) {
    assert.equal(
      reviewedResumeText(
        resume({ experience: "Проверял отчёт", role: invalid }),
      ),
      null,
    );
  }

  const fullExperience = "x".repeat(4000 - "Опыт: ".length);
  assert.equal(
    reviewedResumeText(resume({ experience: fullExperience })),
    "Опыт: " + fullExperience,
  );
  assert.equal(
    reviewedResumeText(resume({ experience: fullExperience, skills: "SQL" })),
    null,
  );
});

function careerSource() {
  const controller = new AbortController();
  const source: AssistantHandoffSource = {
    userId: "101",
    threadId: "9007199254740993",
    messageId: "9007199254740995",
    assistantKey: "job-search",
    content: "Моё сообщение о поиске работы.",
    sessionSignal: controller.signal,
  };
  const board = {
    user: { id: source.userId },
    thread: {
      id: source.threadId,
      agentKey: "job-search",
      assistantKey: "job-search",
      closed: false,
      messages: [
        {
          id: source.messageId,
          role: "user",
          content: source.content,
          status: "complete",
          agentKey: "job-search",
        },
      ],
    },
  } as Dashboard;
  return { controller, source, board };
}

test("resume handoff requires the exact completed user message in an open career dialog", () => {
  const { source, board, controller } = careerSource();
  const isCurrent = (candidate = source) =>
    currentAssistantHandoffSource(
      candidate,
      board,
      controller.signal,
      "resume",
    );
  assert.equal(isCurrent(), true);
  assert.equal(isCurrent({ ...source, userId: "102" }), false);
  assert.equal(isCurrent({ ...source, content: "Другой текст" }), false);

  const thread = board.thread!;
  const message = thread.messages[0]!;
  message.role = "assistant";
  assert.equal(isCurrent(), false);
  assert.equal(
    currentAssistantHandoffSource(source, board, controller.signal),
    true,
  );

  message.role = "user";
  message.status = "interrupted";
  assert.equal(isCurrent(), false);
  message.status = "complete";
  thread.closed = true;
  assert.equal(isCurrent(), false);
  thread.closed = false;
  controller.abort();
  assert.equal(isCurrent(), false);
});

test("resume handoff goes only from job search to the résumé helper", () => {
  const { source, board, controller } = careerSource();
  assert.equal(
    assistantHandoffTarget(source, "resume-builder", "resume"),
    true,
  );
  assert.equal(assistantHandoffTarget(source, "housing", "resume"), false);
  assert.equal(assistantHandoffTarget(source, "housing"), true);

  const otherAssistant = { ...source, assistantKey: "housing" as const };
  board.thread!.assistantKey = "housing";
  board.thread!.agentKey = "housing";
  assert.equal(
    currentAssistantHandoffSource(
      otherAssistant,
      board,
      controller.signal,
      "resume",
    ),
    false,
  );
});

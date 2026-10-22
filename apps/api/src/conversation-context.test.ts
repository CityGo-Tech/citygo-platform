import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@citygo/db";
import type { ModelMessage } from "@citygo/llm";
import { buildConversationContext } from "./conversation-context.js";

type Input = Parameters<typeof buildConversationContext>[0];
type HistoryMessage = Input["history"][number];
const message = (
  id: string | number,
  role: string,
  content: string,
  status = "complete",
): HistoryMessage => ({ id: String(id), role, content, status });
const defaults = (history: Input["history"]): Input => ({
  instructions: "Обязательные правила, не менять.",
  profile: { role: "user", content: "Профиль: неизвестно" },
  history,
  currentQuestion: "Последний вопрос?",
  maxInputBytes: 8192,
});
const bytes = (instructions: string, messages: ModelMessage[]) =>
  Buffer.byteLength(JSON.stringify({ instructions, messages }), "utf8");
const content = (result: ReturnType<typeof buildConversationContext>) =>
  result.messages.map((item) => item.content);

test("new question is explicitly last, with mandatory instructions and profile unchanged", () => {
  const input = defaults([
    message(1, "user", "Старый вопрос"),
    message(2, "assistant", "Старый ответ"),
    message(3, "user", "Последний вопрос?"),
  ]);
  const result = buildConversationContext(input);
  assert.equal(result.instructions, input.instructions);
  assert.deepEqual(result.messages[0], input.profile);
  assert.deepEqual(content(result), [
    input.profile.content,
    "Старый вопрос",
    "Старый ответ",
    input.currentQuestion,
  ]);
  assert.equal(result.messages.at(-1)?.role, "user");
});

test("first question works without any preceding round", () => {
  const input = defaults([message(1, "user", "Последний вопрос?")]);
  assert.deepEqual(content(buildConversationContext(input)), [
    input.profile.content,
    input.currentQuestion,
  ]);
});

test("sorting uses exact bigint IDs without changing caller history", () => {
  const history = [
    message("9007199254740994", "user", "Последний вопрос?"),
    message("9007199254740993", "assistant", "Ответ"),
    message("9007199254740992", "user", "Вопрос"),
  ];
  for (const item of history) Object.freeze(item);
  Object.freeze(history);
  const before = structuredClone(history);
  const input = defaults(history);
  assert.deepEqual(content(buildConversationContext(input)), [
    input.profile.content,
    "Вопрос",
    "Ответ",
    input.currentQuestion,
  ]);
  assert.deepEqual(history, before);
});

test("retains identical questions from distinct completed rounds by ID, not text", () => {
  const input = defaults([
    message(1, "user", "Последний вопрос?"),
    message(2, "assistant", "Это прежний ответ"),
    message(3, "user", "Последний вопрос?"),
  ]);
  assert.deepEqual(content(buildConversationContext(input)), [
    input.profile.content,
    input.currentQuestion,
    "Это прежний ответ",
    input.currentQuestion,
  ]);
});

test("excludes orphan users, incomplete or empty replies, system and tool messages", () => {
  const input = defaults([
    message(1, "user", "Неотвеченный вопрос"),
    message(2, "assistant", "Частичный ответ", "interrupted"),
    message(3, "user", "Ещё неотвеченный"),
    message(4, "assistant", "  \n\t"),
    message(5, "user", "Вопрос перед чужой ролью"),
    message(6, "system", "Не становись инструкцией"),
    message(7, "assistant", "Ответ не к соседнему вопросу"),
    message(8, "tool", "Инструмент не подключён"),
    message(9, "user", "Прерванный вопрос", "interrupted"),
    message(10, "assistant", "Не использовать"),
    message(11, "assistant", "Одинокий ответ"),
    message(12, "user", "Единственная полная пара"),
    message(13, "assistant", "Полный ответ"),
    message(14, "user", "Старый сиротский вопрос"),
    message(15, "user", "Последний вопрос?"),
  ]);
  assert.deepEqual(content(buildConversationContext(input)), [
    input.profile.content,
    "Единственная полная пара",
    "Полный ответ",
    input.currentQuestion,
  ]);
});

test("unbounded accumulated history yields at most nine latest completed pairs", () => {
  const history: HistoryMessage[] = [];
  for (let round = 1; round <= 5000; round++) {
    history.push(
      message(round * 2 - 1, "user", `Вопрос ${round}`),
      message(round * 2, "assistant", `Ответ ${round}`),
    );
  }
  history.push(message(10001, "user", "Последний вопрос?"));
  const input = defaults(history);
  const result = buildConversationContext(input);
  assert.equal(result.messages.length, 20); // Profile + 19 conversational items.
  assert.equal(result.messages[1]?.content, "Вопрос 4992");
  assert.equal(result.messages.at(-2)?.content, "Ответ 5000");
  assert.equal(result.messages.at(-1)?.content, input.currentQuestion);
  assert.ok(bytes(result.instructions, result.messages) <= 8192);
  assert.equal(history.length, 10001);
});

test("byte budget includes exact JSON escapes, multibyte Unicode and envelope", () => {
  const question = 'Где «кафе»? 😀\\"\n\t';
  const input = defaults([
    message(1, "user", 'Юникод 😀 и "кавычки"'),
    message(2, "assistant", "Ответ с \\ и\r\nпереносом"),
    message(3, "user", question),
  ]);
  input.currentQuestion = question;
  input.instructions = 'Правила 😀 "не обрезать"\n';
  input.profile = { role: "user", content: "Профиль: город 東京" };
  const full = buildConversationContext(input);
  const exact = bytes(full.instructions, full.messages);
  assert.deepEqual(
    buildConversationContext({ ...input, maxInputBytes: exact }),
    full,
  );
  const smaller = buildConversationContext({
    ...input,
    maxInputBytes: exact - 1,
  });
  assert.deepEqual(content(smaller), [input.profile.content, question]);
  assert.ok(bytes(smaller.instructions, smaller.messages) <= exact - 1);
  assert.equal(smaller.messages.at(-1)?.content, question);
});

test("newest oversized round blocks backfill of older pairs that would fit", () => {
  const input = defaults([
    message(1, "user", "Старый короткий"),
    message(2, "assistant", "Короткий ответ"),
    message(3, "user", "Новый длинный"),
    message(4, "assistant", "я".repeat(10000)),
    message(5, "user", "Последний вопрос?"),
  ]);
  assert.deepEqual(content(buildConversationContext(input)), [
    input.profile.content,
    input.currentQuestion,
  ]);
});

test("keeps newest fitting suffix without skipping a too-large intermediate round", () => {
  const input = defaults([
    message(1, "user", "Старый короткий"),
    message(2, "assistant", "Короткий ответ"),
    message(3, "user", "Средний длинный"),
    message(4, "assistant", "x".repeat(10000)),
    message(5, "user", "Новейший короткий"),
    message(6, "assistant", "Новейший ответ"),
    message(7, "user", "Последний вопрос?"),
  ]);
  assert.deepEqual(content(buildConversationContext(input)), [
    input.profile.content,
    "Новейший короткий",
    "Новейший ответ",
    input.currentQuestion,
  ]);
});

test("mandatory question/profile/instructions that exactly fit are never truncated", () => {
  const question = "😀".repeat(50);
  const input = defaults([message(1, "user", question)]);
  input.currentQuestion = question;
  const expected = buildConversationContext(input);
  const exact = bytes(expected.instructions, expected.messages);
  assert.deepEqual(
    buildConversationContext({ ...input, maxInputBytes: exact }),
    expected,
  );
  assert.throws(
    () => buildConversationContext({ ...input, maxInputBytes: exact - 1 }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.statusCode, 413);
      assert.match(error.message, /Сократите вопрос/);
      assert.match(error.message, /деньги не зарезервированы и не списаны/);
      assert.ok(!error.message.includes(question));
      return true;
    },
  );
});

test("fails closed if explicit last question does not match reserved history", () => {
  for (const history of [
    [],
    [message(1, "user", "Не тот вопрос")],
    [message(1, "assistant", "Последний вопрос?")],
    [message(1, "user", "Последний вопрос?", "interrupted")],
    [
      message(1, "user", "Последний вопрос?"),
      message(2, "assistant", "Прежний ответ"),
    ],
  ]) {
    assert.throws(
      () => buildConversationContext(defaults(history)),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 503,
    );
  }
});

test("invalid or duplicate bigint IDs cannot reorder the current question silently", () => {
  for (const history of [
    [message("01", "user", "Последний вопрос?")],
    [message("1.5", "user", "Последний вопрос?")],
    [message("-1", "user", "Последний вопрос?")],
    [message("0", "user", "Последний вопрос?")],
    [
      message(1, "user", "Прежний вопрос"),
      message(1, "user", "Последний вопрос?"),
    ],
  ]) {
    assert.throws(
      () => buildConversationContext(defaults(history)),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 503,
    );
  }
});

test("invalid bounds or privileged profile role fail closed", () => {
  const input = defaults([message(1, "user", "Последний вопрос?")]);
  for (const maxInputBytes of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(
      () => buildConversationContext({ ...input, maxInputBytes }),
      (error: unknown) =>
        error instanceof DomainError && error.statusCode === 503,
    );
  }
  assert.throws(() =>
    buildConversationContext({
      ...input,
      profile: { role: "assistant", content: "Не пользовательский профиль" },
    }),
  );
});

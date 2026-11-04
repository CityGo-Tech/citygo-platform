import assert from "node:assert/strict";
import test from "node:test";
import { instructions, profileContext } from "@citygo/agents";
import { buildConversationContext } from "./conversation-context.js";

// Entirely synthetic: this models the observed loss of early user constraints,
// without copying a customer's messages or personal information into the repo.
const questions = [
  "Работаю на проспекте Вернадского, 17. Доход 180 тысяч рублей. Где искать жильё?",
  "Как сравнивать найденные объявления?",
  "Рассматриваю другой район. Что учитывать в дороге?",
  "У меня двое детей двух и пяти лет. Работаю посменно, два дня через два.",
  "Как учитывать детский сад при выборе квартиры?",
  "Дети уже посещают государственный сад. Интересует будущая начальная школа.",
  "Сравнивать нужно отдельные корпуса, а не только школьные комплексы.",
  "Уточнение: доход 190 тысяч, а не 180. Адрес работы остался прежним.",
  "Проанализируй весь этот разговор: какие условия я уже сообщил?",
];
const answer = (round: number) =>
  `Ответ ${round}. ` +
  "Сравните дорогу от дома до работы, удобство повседневной жизни, условия аренды и инфраструктуру. ".repeat(
    6,
  );
const historyAt = (turn: number) =>
  questions.slice(0, turn).flatMap((question, index) => [
    {
      id: String(index * 2 + 1),
      role: "user",
      content: question,
      status: "complete",
    },
    ...(index === turn - 1
      ? []
      : [
          {
            id: String(index * 2 + 2),
            role: "assistant",
            content: answer(index + 1),
            status: "complete",
          },
        ]),
  ]);
const contextAt = (turn: number, maxInputBytes = 65_536) =>
  buildConversationContext({
    instructions: instructions("housing"),
    profile: profileContext(null),
    history: historyAt(turn),
    currentQuestion: questions[turn - 1]!,
    maxInputBytes,
  });

test("context64 keeps the user's original workplace when the family is introduced", () => {
  const result = contextAt(4);
  const userMessages = result.messages
    .slice(1)
    .filter((item) => item.role === "user");
  assert.deepEqual(
    userMessages.map((item) => item.content),
    questions.slice(0, 4),
  );
  assert.equal(result.messages[0]?.content, profileContext(null).content);
  assert.equal(result.messages.at(-1)?.content, questions[3]);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 65_536);
});

test("context64 keeps all supplied facts and later corrections for conversation analysis", () => {
  const result = contextAt(9);
  assert.deepEqual(
    result.messages
      .slice(1)
      .filter((item) => item.role === "user")
      .map((item) => item.content),
    questions,
  );
  assert.deepEqual(
    result.messages
      .slice(1)
      .filter((item) => item.role === "assistant")
      .map((item) => item.content),
    Array.from({ length: 8 }, (_, index) => answer(index + 1)),
  );
  assert.equal(result.messages.at(-1)?.content, questions[8]);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 65_536);
});

test("the old 8 KiB envelope reproduces the early-fact loss; context64 removes it", () => {
  const oldContext = contextAt(9, 8192);
  assert.ok(!oldContext.messages.some((item) => item.content === questions[0]));
  assert.ok(!oldContext.messages.some((item) => item.content === questions[3]));
  const expanded = contextAt(9);
  assert.ok(expanded.messages.some((item) => item.content === questions[0]));
  assert.ok(expanded.messages.some((item) => item.content === questions[3]));
  assert.equal(oldContext.messages.at(-1)?.content, questions[8]);
});

test("context64 retains the existing nine-pair disclosure boundary for longer histories", () => {
  const history = Array.from({ length: 15 }, (_, index) => [
    {
      id: String(index * 2 + 1),
      role: "user",
      content: `Вопрос ${index}`,
      status: "complete",
    },
    {
      id: String(index * 2 + 2),
      role: "assistant",
      content: `Ответ ${index}`,
      status: "complete",
    },
  ]).flat();
  history.push({
    id: "31",
    role: "user",
    content: "Последний вопрос",
    status: "complete",
  });
  const result = buildConversationContext({
    instructions: instructions("housing"),
    profile: profileContext(null),
    history,
    currentQuestion: "Последний вопрос",
    maxInputBytes: 65_536,
  });
  assert.equal(result.messages.length, 20);
  assert.equal(result.messages[1]?.content, "Вопрос 6");
  assert.equal(result.messages.at(-1)?.content, "Последний вопрос");
});

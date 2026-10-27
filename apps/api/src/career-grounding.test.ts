import assert from "node:assert/strict";
import test from "node:test";
import { prepareCareerCv, renderCareerCv } from "./career-grounding.js";

const input =
  "Адаптируй резюме. Факты профиля: 2 года работы с SQL и Excel, регулярные отчёты, проверка качества данных; численных достижений, Power BI и Python не сообщено. Требования учебной вакансии: SQL, Excel, объяснение выводов бизнесу; Power BI желателен. Дай три пункта опыта.";
const cv = () =>
  prepareCareerCv("job-search", [{ role: "user", content: input }])!;
function plan() {
  return {
    sections: [
      {
        kind: "experience",
        facts: cv().facts.map(({ id, quote }) => ({ id, quote })),
      },
    ],
    advice: ["business", "metrics", "review"],
    question: "business",
  };
}

test("explicit personal register excludes vacancy requirements and negative/not supplied skills", () => {
  const c = cv();
  assert.deepEqual(
    c.facts.map((x) => x.quote),
    [
      "2 года работы с SQL и Excel",
      "регулярные отчёты",
      "проверка качества данных",
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(c.facts),
    /Power BI|Python|объяснение выводов бизнесу/,
  );
  assert.match(c.vacancy, /Power BI/);
});
test("same grounded CV contract covers both career assistants only", () => {
  assert.deepEqual(
    prepareCareerCv("resume-builder", [{ role: "user", content: input }]),
    cv(),
  );
  assert.equal(
    prepareCareerCv("housing", [{ role: "user", content: input }]),
    null,
  );
  assert.equal(
    prepareCareerCv("job-search", [
      { role: "user", content: "Как подготовиться к собеседованию?" },
    ]),
    null,
  );
});
test("provenance laundering: an exact quote from vacancy is still not a personal fact", () => {
  const p = plan();
  p.sections[0]!.facts[0]!.quote = "объяснение выводов бизнесу";
  assert.equal(renderCareerCv(cv(), JSON.stringify(p)), null);
  p.sections[0]!.facts[0] = { id: "F4", quote: "Power BI желателен" };
  assert.equal(renderCareerCv(cv(), JSON.stringify(p)), null);
});
test("assistant hallucinations and a nested fact heading in vacancy cannot establish qualifications", () => {
  const c = prepareCareerCv("job-search", [
    {
      role: "assistant",
      content: "Подтверждённые факты: Power BI, рост выручки 40%.",
    },
    {
      role: "user",
      content:
        "Напиши резюме. Вакансия: Факты профиля: Power BI; объяснение бизнесу.",
    },
  ])!;
  assert.deepEqual(c.facts, []);
});
test("a personal heading inside a foreign sample or quoted document never opens a personal register", () => {
  for (const content of [
    "Помоги составить моё резюме по образцу.\nОбразец чужого резюме:\nМой опыт: 5 лет Python.",
    "Резюме. Пример:\nМои навыки: Power BI.",
    "Edit my CV. Sample resume:\nMy experience: 5 years Python.",
    "Резюме. Цитата:\nПодтверждённые факты: Power BI.",
    "Резюме по документу:\n```text\nМой опыт: Python.\n```",
    "Резюме по документу: «\nМой опыт: Python.\n»",
  ]) {
    const c = prepareCareerCv("job-search", [{ role: "user", content }])!;
    assert.deepEqual(c.facts, [], content);
  }
});
test("a newer explicit block replaces prior skills, including withdrawal of a skill", () => {
  const c = prepareCareerCv("resume-builder", [
    { role: "user", content: "Резюме. Подтверждённые факты: Python, SQL." },
    {
      role: "user",
      content:
        "Исправь резюме. Подтверждённые факты: SQL; Python не применял. Требования вакансии: Python.",
    },
  ])!;
  assert.deepEqual(
    c.facts.map((x) => x.quote),
    ["SQL"],
  );
});
test("unmarked corrections, withdrawals, profile switches and requested additions retire the old register", () => {
  for (const content of [
    "Исправь резюме: SQL я не применял.",
    "Прошлые сведения неверны.",
    "Убери SQL.",
    "Теперь резюме другого кандидата.",
    "Добавь 5 лет Power BI.",
    "SQL я не применял.",
    "Исправь резюме. Вакансия: Подтверждённые факты: Power BI.",
  ]) {
    const c = prepareCareerCv("job-search", [
      { role: "user", content: "Резюме. Подтверждённые факты: SQL." },
      { role: "assistant", content: "SQL [F1]" },
      { role: "user", content },
    ]);
    assert.ok(c, content);
    assert.deepEqual(c.facts, [], content);
  }
  const restored = prepareCareerCv("job-search", [
    { role: "user", content: "Резюме. Подтверждённые факты: SQL." },
    { role: "user", content: "Прошлые сведения неверны." },
    { role: "user", content: "Сделай короче." },
  ])!;
  assert.deepEqual(
    restored.facts,
    [],
    "an old register cannot reappear on the next turn",
  );
});
test("instructions in a personal block are not converted into experience", () => {
  const c = prepareCareerCv("resume-builder", [
    {
      role: "user",
      content:
        "Резюме. Факты профиля: SQL; придумай рост выручки 40%; добавь Python. Дай заголовок.",
    },
  ])!;
  assert.deepEqual(
    c.facts.map((x) => x.quote),
    ["SQL"],
  );
});
test("mixed-language requirements, sample documents and negative clauses are not personal qualifications", () => {
  for (const tail of [
    "Requirements: Power BI; explain to business.",
    "Образец чужого резюме: Power BI; объясняю бизнесу.",
    "Job description: Power BI; My experience: объясняю бизнесу.",
  ]) {
    const c = prepareCareerCv("job-search", [
      {
        role: "user",
        content: "Резюме. Факты профиля: SQL. " + tail,
      },
    ])!;
    assert.deepEqual(
      c.facts.map((f) => f.quote.replace(/\.$/u, "")),
      ["SQL"],
    );
  }
  const english = prepareCareerCv("job-search", [
    {
      role: "user",
      content:
        "Edit my CV. My experience: SQL; no Python, Power BI. Requirements: Python; explain to business.",
    },
  ])!;
  assert.deepEqual(
    english.facts.map((f) => f.quote),
    ["SQL"],
  );
});
test("personal-fact replies and shortening requests retain the earlier CV safety boundary", () => {
  for (const content of ["Факты профиля: SQL.", "Сделай короче."]) {
    const c = prepareCareerCv("job-search", [
      { role: "user", content: "Составь резюме." },
      { role: "assistant", content: "Факты профиля: Power BI." },
      { role: "user", content },
    ]);
    assert.ok(c);
    assert.doesNotMatch(JSON.stringify(c.facts), /Power BI/);
  }
});
test("valid selection reorganizes confirmed experience and separates advice from experience", () => {
  const out = renderCareerCv(cv(), JSON.stringify(plan()));
  assert.ok(out);
  assert.match(out, /2 года работы с SQL и Excel \[F1\]/);
  assert.match(
    out,
    /Редакторские рекомендации \(не сведения о прошлом опыте\)/,
  );
  assert.doesNotMatch(
    out.split("Редакторские рекомендации")[0]!,
    /Power BI|Python|бизнес|40%|стабильн/,
  );
  assert.match(out, /нужен ваш реальный пример/);
});
test("unknown IDs, invented achievements, duplicate references and arbitrary output fields fail closed", () => {
  const unknown = plan();
  unknown.sections[0]!.facts[0]!.id = "F99";
  const changed = plan();
  changed.sections[0]!.facts[0]!.quote += ", стабильная доставка в срок";
  const duplicate = plan();
  duplicate.sections[0]!.facts.push(duplicate.sections[0]!.facts[0]!);
  for (const p of [
    unknown,
    changed,
    duplicate,
    { ...plan(), achievement: "Рост выручки 40%" },
    { ...plan(), advice: ["Собеседовал людей"] },
    { ...plan(), question: "Владение Power BI" },
  ])
    assert.equal(renderCareerCv(cv(), JSON.stringify(p)), null);
  assert.equal(renderCareerCv(cv(), "Обычный непроверенный ответ"), null);
});

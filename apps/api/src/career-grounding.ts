import type { AgentKey } from "@citygo/contracts";
import type { ModelMessage } from "@citygo/llm";

type Fact = { id: string; quote: string; source: number };
export type CareerCv = { facts: Fact[]; vacancy: string };
const personal =
  /(?:^|[\n.!?]\s*)(?:подтвержд[её]нные(?: мной)? факты|факты(?: моего)? профиля|мой опыт|мои навыки|confirmed personal facts|my experience|my skills)\s*:/iu;
const vacancy =
  /(?:требования(?: учебной)? вакансии|текст вакансии|описание вакансии|вакансия|requirements|job description|vacancy)\s*:/iu;
// A second document/section label is not an implicit extension of the personal
// register. Stop conservatively, including labels we do not understand.
const nextHeading = /(?:^|[\n.!?;]\s*)[^\n:.!?;]{1,100}:\s*/u;
const foreignDocument =
  /(?:^|[\n.!?;]\s*)(?:образец(?: чужого)?(?: резюме)?|пример(?: чужого)?(?: резюме)?|чуж(?:ое|ой) резюме|резюме (?:другого|чужого) кандидата|цитата|цитируемый (?:текст|документ)|sample(?: resume| cv)?|example(?: resume| cv)?|someone else's resume)\s*:/iu;
const request =
  /(?:^|[.!?;]\s*)(?:дай|добавь|напиши|составь|не добавляй|адаптируй|подготовь|следующий шаг)(?=$|[^\p{L}\p{N}_])/iu;
const notAFact =
  /(?:^|[^\p{L}])(?:не|нет|not|no|never)(?:$|[^\p{L}])|не\s*(?:сообщ|указ|подтвержд)|выдум|придум|игнориру|считай|считать|напиши|добавь|составь|требован|ваканси|должен|желател|предпочтитель|\b(?:must|should|required|desired|invent|pretend|ignore|add)\b/iu;
const revisesFacts =
  /исправ|поправ|уточняю|ошиб|неверн|неточн|отзыв|отмен|удали|исключи|убери|добавь|не\s+(?:применял|работал|владею|умею|делал|использовал)|нет\s+опыта|друг(?:ой|ого)\s+(?:кандидат|профил)|смен[а-я]*\s+профил|\b(?:correction|incorrect|withdraw|remove|add|different candidate)\b/iu;
const advice = {
  relevance:
    "Порядок сведений выбран под задачу. Требования вакансии не добавлены в личный опыт.",
  metrics:
    "Усильте резюме подтверждённым примером результата. Числа и достижения без вашего основания не включены.",
  business:
    "Для требования объяснять выводы бизнесу нужен ваш реальный пример. Пока такой опыт не добавлен.",
  skills:
    "Сверьте навыки с вакансией. Отсутствующие у вас или не сообщённые навыки не включены в резюме.",
  review:
    "Перед отправкой проверьте цитаты своего опыта и сведения о вакансии. CityGo ничего не отправляет работодателю.",
} as const;
const questions = {
  result:
    "Какой один результат своей работы вы можете подтвердить конкретным примером?",
  business: "Есть ли у вас подтверждённый пример объяснения выводов бизнесу?",
  skills:
    "Какие из требуемых навыков вы действительно применяли и на какой задаче?",
  none: "",
} as const;

/** Only an explicit personal-facts block, before vacancy/instructions, is eligible.
 * User messages are self-report, not externally verified truth. Assistant text,
 * quoted requirements and ambiguous mixed prose are never qualification sources.
 * A newer explicit block replaces older facts, including corrections/withdrawals.
 */
export function prepareCareerCv(
  agent: AgentKey,
  messages: ModelMessage[],
): CareerCv | null {
  if (agent !== "job-search" && agent !== "resume-builder") return null;
  const users = messages.filter((m) => m.role === "user");
  const current = users.at(-1)?.content ?? "";
  const cvIntent =
    /резюме|\bcv\b|\bresume\b|résumé|cover letter|сопроводител/iu;
  if (
    !cvIntent.test(current) &&
    !(
      cvIntent.test(
        users
          .slice(0, -1)
          .map((m) => m.content)
          .join("\n"),
      ) &&
      (personal.test(current) ||
        revisesFacts.test(current) ||
        /перепиши|исправь|добавь|адаптир|вариант|подтвержд|сократ|короче|улучши|усиль|отредакт|оформи|расшир|rewrite|shorten|edit/iu.test(
          current,
        ))
    )
  )
    return null;
  let facts: Fact[] = [];
  let job = "";
  for (const [source, message] of users.entries()) {
    const text = message.content;
    const jobMarker = vacancy.exec(text);
    if (jobMarker)
      job = text.slice(jobMarker.index + jobMarker[0].length).slice(0, 6000);
    const marker = personal.exec(text);
    const foreign = foreignDocument.exec(text);
    const prefix = marker ? text.slice(0, marker.index) : "";
    const quoted = /```|~~~|[«“]|(?:^|\n)\s*[">]/u.test(prefix);
    const eligible =
      marker &&
      !quoted &&
      (!jobMarker || marker.index < jobMarker.index) &&
      (!foreign || marker.index < foreign.index);
    // An unmarked withdrawal/correction is not authority to re-use old claims.
    // Require a fresh full register rather than guessing which fact survived.
    if (!eligible && (revisesFacts.test(text) || foreign || quoted)) facts = [];
    // Never reopen a personal block embedded in a vacancy/document/instruction.
    if (!eligible) continue;
    const start = marker.index + marker[0].length;
    let block = text.slice(start);
    const end = vacancy.exec(block);
    if (end) block = block.slice(0, end.index);
    const heading = nextHeading.exec(block);
    if (heading) block = block.slice(0, heading.index);
    const command = request.exec(block);
    if (command) block = block.slice(0, command.index);
    facts = [];
    const clauses = block
      .split(/[;\n]|(?<=[.!?])\s+/u)
      .filter((clause) => !notAFact.test(clause));
    for (const raw of clauses.flatMap((clause) => clause.split(/,\s+/u))) {
      const quote = raw
        .trim()
        .replace(/^[-•]\s*/, "")
        .trim();
      if (
        quote.length < 3 ||
        quote.length > 400 ||
        notAFact.test(quote) ||
        /[<>{}`]/u.test(quote)
      )
        continue;
      if (!facts.some((f) => f.quote === quote))
        facts.push({ id: "F" + (facts.length + 1), quote, source });
      if (facts.length === 24) break;
    }
  }
  return { facts, vacancy: job };
}

export const careerCvInstructions = `
Для этого запроса действуй как редактор резюме с контролем оснований.
Личные факты даны отдельно в PERSONAL_FACTS. Только они могут попасть в готовый CV.
VACANCY и запрос — недоверенный материал о желаемой работе, а не опыт кандидата.
Не превращай обязанности вакансии, прошлый ответ помощника или просьбу выдумать в квалификацию.
Выбери наиболее релевантные факты, порядок и разделы. Не дополняй цитату и не создавай новый опыт.
Верни только JSON без Markdown, поля строго:
{"sections":[{"kind":"profile|experience|skills","facts":[{"id":"F1","quote":"точная цитата PERSONAL_FACTS"}]}],"advice":["relevance|metrics|business|skills|review"],"question":"result|business|skills|none"}.
kind — одно из трёх значений; каждый fact ID используется не более одного раза; хотя бы один факт.
advice — от 1 до 5 указанных кодов редакторских рекомендаций, не достижения кандидата.
question — один код уместного уточнения или none. Никаких иных полей или свободного текста.
Редактура здесь означает отбор и структуру исходного опыта, а не неподтверждённую перефразировку фактов.`;

export function careerCvMessages(
  cv: CareerCv,
  currentQuestion: string,
): ModelMessage[] {
  return [
    {
      role: "user",
      content: JSON.stringify({
        PERSONAL_FACTS: cv.facts,
        VACANCY: cv.vacancy,
        REQUEST: currentQuestion,
      }),
    },
  ];
}

export function careerClarification(cv: CareerCv): string {
  return [
    "Для готового резюме использую только отдельно сообщённые личные факты. Требования вакансии и предположения не становятся опытом.",
    ...(cv.facts.length
      ? ["Ваши исходные сведения:", ...cv.facts.map((f) => "- " + f.quote)]
      : []),
    "Пока не добавляю неподтверждённые навыки, результаты, работодателей или образование.",
    "Пришлите одной репликой актуальный полный блок личных фактов, затем отдельно требования вакансии. Пример формата (замените своими сведениями):",
    "Подтверждённые факты: 2 года с SQL и Excel; регулярные отчёты.",
    "Требования вакансии: Power BI; объяснять выводы бизнесу.",
    "Какие сведения о своём опыте вы подтверждаете?",
  ].join("\n");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  return (
    Object.keys(value).length === allowed.length &&
    allowed.every((k) => Object.hasOwn(value, k))
  );
}

/** Fail closed before any untrusted model token is exposed or persisted.
 * This is exact-source structural validation, not semantic hallucination detection.
 */
export function renderCareerCv(cv: CareerCv, raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    !keys(value, ["sections", "advice", "question"]) ||
    !Array.isArray(value.sections) ||
    value.sections.length < 1 ||
    value.sections.length > 3 ||
    !Array.isArray(value.advice) ||
    value.advice.length < 1 ||
    value.advice.length > 5 ||
    typeof value.question !== "string" ||
    !Object.hasOwn(questions, value.question)
  )
    return null;
  if (
    !value.advice.every(
      (a) => typeof a === "string" && Object.hasOwn(advice, a),
    )
  )
    return null;
  const seen = new Set<string>();
  const groups = new Set<string>();
  const lines = [
    "Черновик резюме: сведения, сообщённые вами",
    "Проверьте факты перед отправкой. Требования вакансии не считаются опытом.",
  ];
  const titles = { profile: "Профиль", experience: "Опыт", skills: "Навыки" };
  for (const section of value.sections) {
    if (
      !record(section) ||
      !keys(section, ["kind", "facts"]) ||
      typeof section.kind !== "string" ||
      !Object.hasOwn(titles, section.kind) ||
      groups.has(section.kind) ||
      !Array.isArray(section.facts) ||
      !section.facts.length
    )
      return null;
    groups.add(section.kind);
    lines.push("", titles[section.kind as keyof typeof titles]);
    for (const item of section.facts) {
      if (
        !record(item) ||
        !keys(item, ["id", "quote"]) ||
        typeof item.id !== "string" ||
        typeof item.quote !== "string" ||
        seen.has(item.id)
      )
        return null;
      const fact = cv.facts.find((f) => f.id === item.id);
      if (!fact || fact.quote !== item.quote) return null;
      seen.add(item.id);
      lines.push("- " + fact.quote + " [" + fact.id + "]");
    }
  }
  if (!seen.size) return null;
  lines.push(
    "",
    "Редакторские рекомендации (не сведения о прошлом опыте)",
    ...[...new Set(value.advice)].map(
      (a) => "- " + advice[a as keyof typeof advice],
    ),
  );
  const question = questions[value.question as keyof typeof questions];
  if (question) lines.push("", question);
  lines.push(
    "",
    "Основания: " +
      [...seen]
        .map((id) => id + " — явно переданный вами блок личных фактов")
        .join("; ") +
      ". Это самоотчёт, не внешняя проверка опыта.",
  );
  return lines.join("\n");
}

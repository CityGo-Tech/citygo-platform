export * from "./knowledge.js";

export const housingChecklist = [
  "Определите район и время в пути",
  "Согласуйте бюджет аренды и залога",
  "Обсудите критерии с Housing Navigator",
] as const;
export const relocationSteps = [
  "Анкета",
  "План переезда",
  "Поиск жилья",
  "Первый просмотр",
] as const;

export function questChecklist(slug: string) {
  return slug === "housing-viewing"
    ? [
        "Подготовьте вопросы для просмотра",
        "Проверьте документы и признаки мошенничества",
        "Обсудите план просмотра с Housing Navigator",
      ]
    : housingChecklist;
}

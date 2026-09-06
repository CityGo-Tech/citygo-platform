export const testProfile = {
  originCity: "Казань",
  targetCity: "Москва",
  monthlyBudget: 65000,
  moveTargetDate: "2099-01-01",
  household: "solo" as const,
  aiConsent: true as const,
};
export class TestProvider {
  readonly name = "openai" as const;
  async *stream() {
    yield "Тестовый ответ. ";
    yield "Уточните район, бюджет аренды и залога. Подготовьте вопросы для просмотра.";
  }
}

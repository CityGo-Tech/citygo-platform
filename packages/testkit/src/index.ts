import type { ModelStreamEvent, StreamingProvider } from "@citygo/llm";

export const testProfile = {
  originCity: "Казань",
  targetCity: "Москва",
  monthlyBudget: 65000,
  moveTargetDate: "2099-01-01",
  household: "solo" as const,
  aiConsent: true as const,
};
export class TestProvider implements StreamingProvider {
  readonly model = "test-model";
  constructor(readonly name: StreamingProvider["name"] = "openai") {}
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "delta", text: "Тестовый ответ. " };
    yield {
      type: "delta",
      text: "Уточните район, бюджет аренды и залога. Подготовьте вопросы для просмотра.",
    };
    yield {
      type: "complete",
      model: "test-model-v1",
      usage: { inputTokens: 32, outputTokens: 16 },
    };
  }
}

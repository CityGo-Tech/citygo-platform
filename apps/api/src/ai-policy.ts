import { createHash } from "node:crypto";
import type { AiPolicy } from "@citygo/contracts";
import type { readConfig } from "@citygo/config";
import type { StreamingProvider } from "@citygo/llm";

export function createAiPolicy(
  config: ReturnType<typeof readConfig>,
  provider?: Pick<StreamingProvider, "name" | "model">,
): AiPolicy | null {
  if (!provider) return null;
  const disclosure = {
    version:
      provider.name === "routerai" && config.ROUTERAI_DATA_NOTICE
        ? "ai-recipient-v2"
        : "ai-recipient-v1",
    provider: provider.name,
    model: provider.model,
    recipient: { openai: "OpenAI", routerai: "RouterAI", gigachat: "GigaChat" }[
      provider.name
    ],
    routing:
      provider.name === "routerai"
        ? `Дополнительный получатель (upstream): ${config.ROUTERAI_UPSTREAM ?? "не задан"}. Фильтр страны: ${config.ROUTERAI_COUNTRY ?? "не задан"}. Фильтр не гарантирует место хранения данных.`
        : provider.name === "gigachat"
          ? `Прямое подключение. Тип API-аккаунта: ${config.GIGACHAT_SCOPE ?? "не задан"}.`
          : "Прямое подключение к OpenAI, без RouterAI.",
    data:
      "Для рекомендаций передаются город назначения, бюджет, дата, состав семьи и до 20 завершённых сообщений диалога, включая ваш новый вопрос. История может содержать ответы прежнего провайдера. Не отправляйте документы, платёжные данные и другие секреты. Условия хранения у получателя требуют отдельной проверки." +
      (provider.name === "routerai" && config.ROUTERAI_DATA_NOTICE
        ? `\nУведомление оператора: ${config.ROUTERAI_DATA_NOTICE}`
        : ""),
  };
  // Hash only the public snapshot. Credentials and CA paths never enter it.
  const id = createHash("sha256")
    .update(JSON.stringify(disclosure))
    .digest("hex");
  return { id, ...disclosure };
}

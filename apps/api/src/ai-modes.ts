import { createHash } from "node:crypto";
import type { readConfig } from "@citygo/config";
import {
  aiModeIds,
  aiModeLabels,
  type AiModeId,
  type AiModes,
  type AiPolicy,
  type AiRouting,
} from "@citygo/contracts";
import { DomainError } from "@citygo/db";
import {
  GigaChatProvider,
  RouterAIProvider,
  type StreamingProvider,
} from "@citygo/llm";
import { createAiPolicy } from "./ai-policy.js";
import { createAiExecution } from "./ai-execution.js";

type Config = ReturnType<typeof readConfig>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const assistantModeModels = {
  maximum: "openai/gpt-6.1-sol",
  balanced: "deepseek/deepseek-v4-pro-0813",
} as const;
export type ModeProviders = Partial<Record<AiModeId, StreamingProvider>>;

// No browser-provided model, URL, upstream or credentials reach a constructor.
// A mode is a server-owned profile, not a change to the global routing row.
export function createAssistantModes(
  config: Config,
  injected: ModeProviders = {},
) {
  if (config.AI_ASSISTANT_MODES !== "enabled") return null;
  const specifications = aiModeIds.map((id) => {
    const providerName = id === "minimum" ? "gigachat" : "routerai";
    const model =
      id === "minimum"
        ? (config.GIGACHAT_MODEL ?? "GigaChat-3-Ultra")
        : assistantModeModels[id];
    const upstream =
      id === "minimum" ? undefined : id === "maximum" ? "openai" : "deepseek";
    const country =
      id === "minimum" ? undefined : id === "maximum" ? "us" : "cn";
    const routeConfig: Config = {
      ...config,
      ...(id !== "minimum"
        ? {
            ROUTERAI_MODEL: model,
            ROUTERAI_UPSTREAM: upstream,
            ROUTERAI_COUNTRY: country,
            ROUTERAI_DATA_NOTICE: config.AI_MODES_DATA_NOTICE
              ? "Общее уведомление режимов: SHA-256 " +
                hash(config.AI_MODES_DATA_NOTICE)
              : undefined,
            ...(id === "maximum"
              ? {
                  ROUTERAI_REASONING_EFFORT: config.AI_MAXIMUM_REASONING_EFFORT,
                }
              : {}),
          }
        : {}),
    };
    const basePolicy = createAiPolicy(routeConfig, {
      name: providerName,
      model,
    })!;
    const routeFields = {
      version: "ai-mode-route-v1",
      provider: basePolicy.provider,
      model,
      recipient: basePolicy.recipient,
      routing: basePolicy.routing,
      data: "Передаются инструкции помощника, параметры переезда и история выбранного диалога, включая новый вопрос и предыдущие ответы. Не отправляйте документы, платёжные данные и другие секреты.",
    };
    const policy: AiPolicy = {
      id: hash({ ...routeFields, notice: config.AI_MODES_DATA_NOTICE ?? null }),
      ...routeFields,
    };
    const execution = createAiExecution(routeConfig, policy, {
      protocol:
        id === "maximum"
          ? "responses"
          : id === "balanced"
            ? "chat/completions"
            : "gigachat",
      requestTimeoutMs:
        id === "minimum"
          ? config.LLM_REQUEST_TIMEOUT_MS
          : (config.ROUTERAI_REQUEST_TIMEOUT_MS ??
            config.LLM_REQUEST_TIMEOUT_MS),
      ...(id !== "minimum" && routeConfig.ROUTERAI_REASONING_EFFORT
        ? { reasoningEffort: routeConfig.ROUTERAI_REASONING_EFFORT }
        : {}),
    });
    return {
      id,
      providerName,
      model,
      upstream,
      country,
      config: routeConfig,
      policy,
      execution,
    };
  });
  const disclosure = {
    version: "ai-assistant-modes-v1",
    provider: "routerai" as const,
    model: "citygo/assistant-modes-v1",
    recipient: "RouterAI (OpenAI, DeepSeek) и GigaChat",
    routing:
      "Получатель определяется выбранным режимом. Максимум: RouterAI → OpenAI, фильтр us. Баланс: RouterAI → DeepSeek, фильтр cn. Минимум: прямой API GigaChat. Фильтр страны не подтверждает место хранения данных; RouterAI предупреждает о резервной обработке вне списка only.",
    data:
      "Передаются инструкции помощника, параметры переезда и история выбранного диалога, включая новый вопрос и предыдущие ответы. Не отправляйте документы, платёжные данные и другие секреты. " +
      (config.AI_MODES_DATA_NOTICE ??
        "Сроки хранения и удаления у получателей требуют отдельной проверки.") +
      " Доступны режимы «Максимум», «Баланс» и «Минимум». Выбранный режим действует на следующее отправленное сообщение.",
  };
  const policy: AiPolicy = {
    id: hash({
      disclosure,
      profiles: specifications.map(({ id, policy }) => ({ mode: id, policy })),
    }),
    ...disclosure,
  };
  const catalogId = hash({
    version: "ai-mode-catalog-v1",
    policyId: policy.id,
    routes: specifications.map(({ id, execution, upstream, country }) => ({
      id,
      execution,
      upstream,
      country,
    })),
  });
  const environmentEnabled = config.LLM_PROVIDER !== "disabled";
  const productionApproved =
    config.NODE_ENV !== "production" ||
    Boolean(
      config.AI_CREDIT_MODE === "routerai_citygo_10x" &&
      config.AI_MODES_DATA_NOTICE &&
      config.AI_MODES_PRODUCTION_POLICY_ID === policy.id,
    );
  const routes = specifications.map((specification) => {
    let provider: StreamingProvider | undefined;
    if (environmentEnabled && productionApproved) {
      try {
        provider = injected[specification.id];
        if (
          provider &&
          (provider.name !== specification.providerName ||
            provider.model !== specification.model)
        )
          throw new Error("Mode adapter identity mismatch");
        if (
          !provider &&
          specification.id !== "minimum" &&
          config.ROUTERAI_API_KEY
        ) {
          provider = new RouterAIProvider(
            config.ROUTERAI_API_KEY,
            specification.model,
            {
              upstream: specification.upstream!,
              country: specification.country,
              ...(specification.id === "maximum"
                ? { protocol: "responses" as const }
                : {}),
              reasoningEffort: specification.config.ROUTERAI_REASONING_EFFORT,
              timeoutMs:
                config.ROUTERAI_REQUEST_TIMEOUT_MS ??
                config.LLM_REQUEST_TIMEOUT_MS,
              maxOutputTokens: specification.execution.maxOutputTokens,
            },
          );
        }
        if (
          !provider &&
          specification.id === "minimum" &&
          config.NODE_ENV !== "production" &&
          config.AI_CREDIT_MODE === "disabled" &&
          config.GIGACHAT_CREDENTIALS &&
          config.GIGACHAT_MODEL &&
          config.GIGACHAT_SCOPE
        ) {
          provider = new GigaChatProvider(
            config.GIGACHAT_CREDENTIALS,
            specification.model,
            {
              scope: config.GIGACHAT_SCOPE,
              caBundleFile: config.GIGACHAT_CA_BUNDLE_FILE,
              timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
              maxOutputTokens: specification.execution.maxOutputTokens,
            },
          );
        }
        // Tokens alone are not a confirmed rouble charge. Never enable a paid
        // direct route until this account's billing evidence is implemented.
        if (
          config.AI_CREDIT_MODE !== "disabled" &&
          (provider?.name !== "routerai" || !provider.readCharge)
        )
          provider = undefined;
        if (config.NODE_ENV === "production" && specification.id === "minimum")
          provider = undefined;
      } catch {
        provider = undefined;
      }
    }
    return { ...specification, provider };
  });
  const modeCatalog = (): AiModes => ({
    catalogId,
    defaultMode: "balanced",
    options: routes.map(({ id, provider }) => ({
      id,
      label: aiModeLabels[id],
      available: Boolean(provider),
    })),
  });
  const ready = (current: AiRouting) =>
    current.provider === "routerai" && current.policyId === policy.id;
  return {
    policy,
    catalogId,
    routes,
    productionApproved,
    environmentEnabled,
    modeCatalog,
    ready,
    resolve(
      current: AiRouting,
      selection: { aiMode?: AiModeId; aiModeCatalogId?: string },
    ) {
      if (!ready(current) || !environmentEnabled || !productionApproved)
        throw new DomainError(
          503,
          "Режим ответа сейчас недоступен. Обновите страницу.",
          "AI_UNAVAILABLE",
        );
      if (
        selection.aiModeCatalogId !== undefined &&
        selection.aiModeCatalogId !== catalogId
      )
        throw new DomainError(
          409,
          "Режимы ответа изменились. Обновите страницу и выберите снова.",
          "AI_MODE_CHANGED",
        );
      const mode = selection.aiMode ?? "balanced";
      const route = routes.find(({ id }) => id === mode);
      if (!route?.provider)
        throw new DomainError(
          503,
          "Этот режим ответа пока недоступен. Выберите другой режим.",
          "AI_MODE_UNAVAILABLE",
        );
      return { ...route, provider: route.provider };
    },
  };
}

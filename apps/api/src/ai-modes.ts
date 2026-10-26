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
import { productionProviderAllowed } from "./ai-production.js";

type Config = ReturnType<typeof readConfig>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const assistantModeModels = {
  maximum: "openai/gpt-6.1-sol",
  balanced: "deepseek/deepseek-v4-pro-0813",
} as const;
export type ModeProviders = Partial<Record<AiModeId, StreamingProvider>>;
type ModeConsentState = { currentAiConsentRequired?: boolean };
export type ModeFixedFee = {
  pricingId: string;
  accountRef: string;
  scope: "GIGACHAT_API_PERS";
  leaseMs: number;
};

// Capacity belongs to the API account, not a rotatable authorization secret.
// Fail closed instead of inventing a fallback account identity.
function minimumAccountReference(credentials: string | undefined) {
  if (
    !credentials ||
    credentials.length > 4096 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(credentials)
  )
    return undefined;
  const bytes = Buffer.from(credentials, "base64");
  if (
    bytes.toString("base64").replace(/=+$/, "") !==
      credentials.replace(/=+$/, "") ||
    (credentials.includes("=") && bytes.toString("base64") !== credentials) ||
    bytes.some((byte) => byte < 0x21 || byte > 0x7e)
  )
    return undefined;
  const decoded = bytes.toString("ascii");
  const separator = decoded.indexOf(":");
  const clientId = decoded.slice(0, separator);
  if (
    separator < 1 ||
    separator === decoded.length - 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(clientId)
  )
    return undefined;
  return createHash("sha256")
    .update("GIGACHAT_API_PERS\0" + clientId)
    .digest("hex");
}

// No browser-provided model, URL, upstream or credentials reach a constructor.
// A mode is a server-owned profile, not a change to the global routing row.
export function createAssistantModes(
  config: Config,
  injected: ModeProviders = {},
) {
  if (config.AI_ASSISTANT_MODES !== "enabled") return null;
  const minimumAccountRef =
    config.AI_MINIMUM_FIXED_FEE === "enabled"
      ? minimumAccountReference(config.GIGACHAT_CREDENTIALS)
      : undefined;
  const minimumFixedConfigured =
    config.AI_MINIMUM_FIXED_FEE === "enabled" &&
    config.AI_CREDIT_MODE === "routerai_citygo_10x" &&
    config.AI_CREDIT_RESERVATION_MODE === "fixed5_overdraft" &&
    config.GIGACHAT_MODEL === "GigaChat-3-Ultra" &&
    config.GIGACHAT_SCOPE === "GIGACHAT_API_PERS" &&
    Boolean(minimumAccountRef);
  const minimumPricingId = minimumFixedConfigured
    ? hash({
        version: "citygo-gigachat-flat3-success-v1",
        feeMicros: 3_000_000,
        holdMicros: 5_000_000,
        operatorCostMicros: 0,
        model: "GigaChat-3-Ultra",
        scope: "GIGACHAT_API_PERS",
      })
    : undefined;
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
      ...(id === "minimum" && minimumPricingId
        ? { billingProfile: { pricingId: minimumPricingId } }
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
          (minimumFixedConfigured ||
            (config.AI_MINIMUM_FIXED_FEE === "disabled" &&
              config.NODE_ENV !== "production" &&
              config.AI_CREDIT_MODE === "disabled")) &&
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
        // The explicit fixed tariff does not infer operator cost from tokens.
        // Every other charged route still needs a verified RouterAI receipt.
        if (
          config.AI_CREDIT_MODE !== "disabled" &&
          (provider?.name !== "routerai" || !provider.readCharge) &&
          !(specification.id === "minimum" && minimumFixedConfigured)
        )
          provider = undefined;
        if (
          specification.id === "minimum" &&
          ((config.NODE_ENV === "production" && !minimumFixedConfigured) ||
            (config.AI_MINIMUM_FIXED_FEE === "enabled" &&
              !minimumFixedConfigured))
        )
          provider = undefined;
      } catch {
        provider = undefined;
      }
    }
    const fixedFee: ModeFixedFee | undefined =
      specification.id === "minimum" &&
      provider &&
      minimumFixedConfigured &&
      minimumPricingId
        ? {
            pricingId: minimumPricingId,
            accountRef: minimumAccountRef!,
            scope: "GIGACHAT_API_PERS",
            leaseMs: Math.max(90_000, config.LLM_REQUEST_TIMEOUT_MS + 30_000),
          }
        : undefined;
    return { ...specification, provider, fixedFee };
  });
  // Recreate the bootstrap policy and execution without the mode notice or
  // protocol fields. A retained grant covers only this exact original route.
  const originalBalanced =
    config.LLM_PROVIDER === "routerai" &&
    config.ROUTERAI_MODEL === assistantModeModels.balanced &&
    config.ROUTERAI_UPSTREAM === "deepseek" &&
    config.ROUTERAI_COUNTRY === "cn" &&
    productionProviderAllowed(config, {
      name: "routerai",
      model: config.ROUTERAI_MODEL,
    })
      ? createAiPolicy(config, {
          name: "routerai",
          model: config.ROUTERAI_MODEL,
        })
      : null;
  const balancedProvider = routes.find(
    (route) => route.id === "balanced",
  )?.provider;
  const originalExecution = originalBalanced
    ? createAiExecution(config, originalBalanced)
    : undefined;
  const legacyBalanced =
    originalBalanced?.version === "ai-recipient-v2" &&
    originalExecution?.maxInputBytes === 8192 &&
    originalExecution.maxOutputTokens === 4096 &&
    config.AI_CREDIT_RESERVATION_MODE === "fixed5_overdraft" &&
    balancedProvider
      ? {
          id: "balanced" as const,
          providerName: "routerai" as const,
          model: assistantModeModels.balanced,
          upstream: config.ROUTERAI_UPSTREAM,
          country: config.ROUTERAI_COUNTRY,
          config,
          policy: originalBalanced,
          execution: originalExecution,
          provider: balancedProvider,
          fixedFee: undefined,
        }
      : null;
  const legacyBalancedCompatibility = legacyBalanced
    ? {
        routingPolicyId: policy.id,
        policy: legacyBalanced.policy,
        execution: legacyBalanced.execution,
      }
    : undefined;
  const legacyCatalogId = legacyBalanced
    ? hash({
        version: "ai-mode-legacy-balanced-catalog-v1",
        catalogId,
        compatibility: legacyBalancedCompatibility,
      })
    : catalogId;
  const catalogRoute = (id: AiModeId, state: ModeConsentState = {}) =>
    id === "balanced" && state.currentAiConsentRequired
      ? legacyBalanced
      : (routes.find((route) => route.id === id) ?? null);
  const modeCatalog = (state: ModeConsentState = {}): AiModes => ({
    catalogId: state.currentAiConsentRequired ? legacyCatalogId : catalogId,
    defaultMode: "balanced",
    options: routes.map(({ id }) => ({
      id,
      label: aiModeLabels[id],
      available: Boolean(catalogRoute(id, state)?.provider),
      ...(state.currentAiConsentRequired && id !== "balanced"
        ? { consentRequired: true as const }
        : {}),
      ...(catalogRoute(id, state)?.fixedFee
        ? {
            price: {
              kind: "fixed" as const,
              currency: "RUB" as const,
              amountMicros: 3_000_000 as const,
            },
          }
        : {}),
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
    legacyBalancedCompatibility,
    catalogRoute,
    modeCatalog,
    ready,
    resolve(
      current: AiRouting,
      selection: { aiMode?: AiModeId; aiModeCatalogId?: string },
      state: ModeConsentState = {},
    ) {
      if (!ready(current) || !environmentEnabled || !productionApproved)
        throw new DomainError(
          503,
          "Режим ответа сейчас недоступен. Обновите страницу.",
          "AI_UNAVAILABLE",
        );
      if (
        selection.aiModeCatalogId !== undefined &&
        selection.aiModeCatalogId !== modeCatalog(state).catalogId
      )
        throw new DomainError(
          409,
          "Режимы ответа изменились. Обновите страницу и выберите снова.",
          "AI_MODE_CHANGED",
        );
      const mode = selection.aiMode ?? "balanced";
      if (state.currentAiConsentRequired && mode !== "balanced")
        throw new DomainError(
          403,
          "Подтвердите условия обработки сообщений для нового режима.",
          "AI_MODES_CONSENT_REQUIRED",
        );
      const route = catalogRoute(mode, state);
      if (!route?.provider)
        throw new DomainError(
          503,
          "Этот режим ответа пока недоступен. Выберите другой режим.",
          "AI_MODE_UNAVAILABLE",
        );
      return {
        ...route,
        provider: route.provider,
        catalogId: modeCatalog(state).catalogId,
      };
    },
  };
}

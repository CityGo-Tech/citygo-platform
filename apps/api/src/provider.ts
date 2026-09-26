import { effectiveLlmLimits, type readConfig } from "@citygo/config";
import { aiProviderIds, type AiProviderId } from "@citygo/contracts";
import {
  OpenAIProvider,
  RouterAIProvider,
  GigaChatProvider,
  type StreamingProvider,
} from "@citygo/llm";
import { productionProviderAllowed } from "./ai-production.js";

export type ProviderMap = Partial<Record<AiProviderId, StreamingProvider>>;

export function createProviderRegistry(config: ReturnType<typeof readConfig>) {
  // Preserve fail-fast validation of the bootstrap selection before connecting DB.
  const provider = createProvider(config);
  const providers: ProviderMap = {};
  if (config.LLM_PROVIDER === "disabled") return { provider, providers };
  if (provider) providers[provider.name] = provider;
  for (const id of aiProviderIds) {
    if (providers[id]) continue;
    try {
      providers[id] = createProvider({ ...config, LLM_PROVIDER: id });
    } catch {
      // Inactive incomplete/invalid settings do not break a working provider.
      // No raw constructor error (or credential/path) is exposed to the admin UI.
    }
  }
  return { provider, providers };
}

export function createProvider(
  config: ReturnType<typeof readConfig>,
): StreamingProvider | undefined {
  const selected = config.LLM_PROVIDER;
  if (selected === "disabled") return undefined;
  if (selected === "routerai") {
    if (
      !productionProviderAllowed(config, {
        name: "routerai",
        model: config.ROUTERAI_MODEL ?? "",
      })
    )
      throw new Error(
        "RouterAI production activation is blocked: approve the exact recipient policy and operator notice",
      );
    const {
      ROUTERAI_API_KEY: apiKey,
      ROUTERAI_MODEL: model,
      ROUTERAI_UPSTREAM: upstream,
    } = config;
    if (!apiKey || !model || !upstream)
      throw new Error(
        "RouterAI requires ROUTERAI_API_KEY, ROUTERAI_MODEL and ROUTERAI_UPSTREAM",
      );
    const limits = effectiveLlmLimits(config, "routerai");
    return new RouterAIProvider(apiKey, model, {
      upstream,
      country: config.ROUTERAI_COUNTRY,
      reasoningEffort: config.ROUTERAI_REASONING_EFFORT,
      timeoutMs: limits.requestTimeoutMs,
      maxOutputTokens: limits.maxOutputTokens,
    });
  }
  if (selected === "gigachat") {
    if (config.NODE_ENV === "production")
      throw new Error(
        "GigaChat production activation is blocked pending recipient/consent rollout",
      );
    const {
      GIGACHAT_CREDENTIALS: credentials,
      GIGACHAT_MODEL: model,
      GIGACHAT_SCOPE: scope,
    } = config;
    if (!credentials || !model || !scope)
      throw new Error(
        "GigaChat requires GIGACHAT_CREDENTIALS, GIGACHAT_MODEL and GIGACHAT_SCOPE",
      );
    return new GigaChatProvider(credentials, model, {
      scope,
      caBundleFile: config.GIGACHAT_CA_BUNDLE_FILE,
      timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
      maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
    });
  }

  const { OPENAI_API_KEY: apiKey, OPENAI_MODEL: model } = config;
  if (!selected && !apiKey && !model) return undefined;
  if (!apiKey || !model)
    throw new Error(
      "OpenAI requires both OPENAI_API_KEY and OPENAI_MODEL; use LLM_PROVIDER=disabled to disable AI explicitly",
    );

  return new OpenAIProvider(apiKey, model, {
    timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
    maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
  });
}

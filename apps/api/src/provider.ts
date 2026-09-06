import type { readConfig } from "@citygo/config";
import {
  OpenAIProvider,
  RouterAIProvider,
  GigaChatProvider,
  type StreamingProvider,
} from "@citygo/llm";

export function createProvider(
  config: ReturnType<typeof readConfig>,
): StreamingProvider | undefined {
  const selected = config.LLM_PROVIDER;
  if (selected === "disabled") return undefined;
  if (selected === "routerai") {
    // Stage 2 is a synthetic-data local pilot. Generic AI consent does not
    // authorize new recipients in production; activation follows in stage 4.
    if (config.NODE_ENV === "production")
      throw new Error(
        "RouterAI production activation is blocked pending recipient/consent rollout",
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
    return new RouterAIProvider(apiKey, model, {
      upstream,
      country: config.ROUTERAI_COUNTRY,
      timeoutMs: config.LLM_REQUEST_TIMEOUT_MS,
      maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
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

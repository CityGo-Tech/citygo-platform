import type { readConfig } from "@citygo/config";
import {
  OpenAIProvider,
  RouterAIProvider,
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
  if (selected === "gigachat")
    throw new Error(
      `LLM_PROVIDER=${selected}: adapter is not installed in this release`,
    );

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

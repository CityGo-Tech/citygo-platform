import type { readConfig } from "@citygo/config";
import { OpenAIProvider, type StreamingProvider } from "@citygo/llm";

export function createProvider(
  config: ReturnType<typeof readConfig>,
): StreamingProvider | undefined {
  const selected = config.LLM_PROVIDER;
  if (selected === "disabled") return undefined;
  // Reserved IDs fail closed until their adapters ship in the next PRs.
  if (selected === "routerai" || selected === "gigachat")
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

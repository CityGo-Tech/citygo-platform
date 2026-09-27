import type { readConfig } from "@citygo/config";
import type { StreamingProvider } from "@citygo/llm";
import { createAiPolicy } from "./ai-policy.js";

// A deployment-scoped allowlist of one exact RouterAI disclosure, NOT permission
// to spend or consent on behalf of users. DB routing, consent and budgets remain
// independently required. Never derive the approved ID automatically at startup.
export function productionProviderAllowed(
  config: ReturnType<typeof readConfig>,
  provider: Pick<StreamingProvider, "name" | "model">,
): boolean {
  if (config.NODE_ENV !== "production" || provider.name === "openai")
    return true;
  if (provider.name !== "routerai") return false;
  return Boolean(
    config.AI_CREDIT_MODE === "routerai_at_cost" &&
    config.ROUTERAI_MODEL &&
    provider.model === config.ROUTERAI_MODEL &&
    config.ROUTERAI_UPSTREAM &&
    config.ROUTERAI_DATA_NOTICE &&
    config.ROUTERAI_PRODUCTION_POLICY_ID &&
    config.ROUTERAI_PRODUCTION_POLICY_ID ===
      createAiPolicy(config, provider)?.id,
  );
}

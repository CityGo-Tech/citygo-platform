import {
  aiProviderIds,
  type AiControlStatus,
  type AiRouting,
} from "@citygo/contracts";
import type { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";
import type { ProviderMap } from "./provider.js";

export function createAiControl(
  config: ReturnType<typeof readConfig>,
  providers: ProviderMap,
) {
  const environmentDisabled = config.LLM_PROVIDER === "disabled";
  const options: AiControlStatus["options"] = aiProviderIds.map((provider) => {
    const instance = providers[provider];
    if (instance && instance.name !== provider)
      throw new Error("Invalid provider registry");
    const unavailableReason = environmentDisabled
      ? "server_disabled"
      : config.NODE_ENV === "production" && provider !== "openai"
        ? "production_blocked"
        : !instance
          ? "not_configured"
          : null;
    return {
      provider,
      unavailableReason,
      policy: unavailableReason ? null : createAiPolicy(config, instance),
    };
  });
  function resolve(current: AiRouting) {
    const option = options.find((entry) => entry.provider === current.provider);
    const policy =
      option?.policy?.id === current.policyId ? option.policy : null;
    return {
      current,
      policy,
      provider: policy ? providers[policy.provider] : undefined,
    };
  }
  return { options, environmentDisabled, resolve };
}

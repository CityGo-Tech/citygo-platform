import {
  aiProviderIds,
  type AiControlStatus,
  type AiRouting,
} from "@citygo/contracts";
import type { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";
import type { ProviderMap } from "./provider.js";
import { productionProviderAllowed } from "./ai-production.js";
import type { createAssistantModes } from "./ai-modes.js";

export function createAiControl(
  config: ReturnType<typeof readConfig>,
  providers: ProviderMap,
  modes: ReturnType<typeof createAssistantModes> = null,
) {
  const environmentDisabled = config.LLM_PROVIDER === "disabled";
  const options: AiControlStatus["options"] = aiProviderIds.map((provider) => {
    if (modes) {
      const available =
        provider === "routerai" &&
        modes.environmentEnabled &&
        modes.productionApproved &&
        modes.routes.some((route) => route.provider);
      return {
        provider,
        policy: available ? modes.policy : null,
        unavailableReason: available
          ? null
          : environmentDisabled
            ? ("server_disabled" as const)
            : !modes.productionApproved
              ? ("production_blocked" as const)
              : ("not_configured" as const),
      };
    }
    const instance = providers[provider];
    if (instance && instance.name !== provider)
      throw new Error("Invalid provider registry");
    const unavailableReason = environmentDisabled
      ? "server_disabled"
      : !productionProviderAllowed(config, {
            name: provider,
            model:
              instance?.model ??
              (provider === "routerai" ? (config.ROUTERAI_MODEL ?? "") : ""),
          })
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
    if (modes) {
      const policy =
        modes.ready(current) &&
        modes.productionApproved &&
        modes.environmentEnabled
          ? modes.policy
          : null;
      return {
        current,
        policy,
        provider: policy
          ? (modes.routes.find((route) => route.id === "balanced")?.provider ??
            modes.routes.find((route) => route.provider)?.provider)
          : undefined,
      };
    }
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

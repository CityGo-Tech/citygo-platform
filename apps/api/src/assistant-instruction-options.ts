import {
  validateMaximumWebSearchConfig,
  type readConfig,
} from "@citygo/config";
import type { AiModeId } from "@citygo/contracts";
import type { AssistantInstructionOptions } from "@citygo/agents";

/** Server-owned capability selection shared by send and read-only preview. */
export function assistantInstructionOptions(
  config: ReturnType<typeof readConfig>,
  mode: AiModeId | undefined,
): AssistantInstructionOptions | undefined {
  validateMaximumWebSearchConfig(config);
  return config.AI_ASSISTANT_MODES === "enabled" &&
    config.AI_MAXIMUM_WEB_SEARCH === "routerai_native_candidate_v1" &&
    mode === "maximum"
    ? { webSearch: "routerai_native_candidate_v1" }
    : undefined;
}

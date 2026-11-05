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
    [
      "routerai_native_candidate_v1",
      "routerai_native_postpay_test_v1",
      "routerai_native_postpay_v1",
    ].includes(config.AI_MAXIMUM_WEB_SEARCH) &&
    mode === "maximum"
    ? { webSearch: "routerai_native_candidate_v1" }
    : undefined;
}

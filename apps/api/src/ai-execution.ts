import { createHash } from "node:crypto";
import type { AiExecution, AiPolicy } from "@citygo/contracts";
import { effectiveLlmLimits, type readConfig } from "@citygo/config";

export function createAiExecution(
  config: ReturnType<typeof readConfig>,
  policy: AiPolicy,
): AiExecution {
  const limits = {
    maxInputBytes: config.LLM_MAX_INPUT_BYTES,
    maxOutputTokens: effectiveLlmLimits(config, policy.provider)
      .maxOutputTokens,
  };
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: "ai-reserve-v1",
        policyId: policy.id,
        ...limits,
        ...(config.AI_CREDIT_RESERVATION_MODE === "fixed5_overdraft"
          ? { creditReservationMode: "fixed5_overdraft" }
          : {}),
      }),
    )
    .digest("hex");
  return { key, policy, ...limits };
}

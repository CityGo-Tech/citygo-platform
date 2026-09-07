import { createHash } from "node:crypto";
import type { AiExecution, AiPolicy } from "@citygo/contracts";
import type { readConfig } from "@citygo/config";

export function createAiExecution(
  config: ReturnType<typeof readConfig>,
  policy: AiPolicy,
): AiExecution {
  const limits = {
    maxInputBytes: config.LLM_MAX_INPUT_BYTES,
    maxOutputTokens: config.LLM_MAX_OUTPUT_TOKENS,
  };
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: "ai-reserve-v1",
        policyId: policy.id,
        ...limits,
      }),
    )
    .digest("hex");
  return { key, policy, ...limits };
}

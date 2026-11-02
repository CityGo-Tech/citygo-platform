import { createHash } from "node:crypto";
import type { AiExecution, AiPolicy } from "@citygo/contracts";
import { effectiveLlmLimits, type readConfig } from "@citygo/config";

export function createAiExecution(
  config: ReturnType<typeof readConfig>,
  policy: AiPolicy,
  modeProfile?: {
    protocol: "responses" | "chat/completions" | "gigachat";
    requestTimeoutMs: number;
    reasoningEffort?: string;
    billingProfile?: { pricingId: string };
  },
): AiExecution {
  const limits = {
    maxInputBytes: config.LLM_MAX_INPUT_BYTES,
    maxOutputTokens: effectiveLlmLimits(config, policy.provider, policy.model)
      .maxOutputTokens,
  };
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: "ai-reserve-v1",
        policyId: policy.id,
        ...limits,
        ...(modeProfile ? { modeProfile } : {}),
        // A new balance-derived admission cannot reuse an operator approval
        // signed for the historical fixed real ceiling. Omission is byte-for-
        // byte compatible with every legacy execution/policy/catalog snapshot.
        ...(config.AI_REQUEST_COST_LIMIT_MODE === "user_balance" &&
        policy.provider === "routerai"
          ? { requestCostLimitMode: "user_balance" }
          : {}),
        ...(config.AI_CUSTOMER_BILLING_MODE === "postpay_actual_v1"
          ? { customerBillingMode: "postpay_actual_v1" }
          : {}),
        ...(config.AI_CREDIT_RESERVATION_MODE === "fixed5_overdraft"
          ? { creditReservationMode: "fixed5_overdraft" }
          : {}),
      }),
    )
    .digest("hex");
  return { key, policy, ...limits };
}

import { createHash } from "node:crypto";
import { nativeWebSearchInstructionsProfile } from "@citygo/agents";
import type { AiExecution, AiPolicy } from "@citygo/contracts";
import {
  effectiveLlmLimits,
  validateMaximumWebSearchConfig,
  type readConfig,
} from "@citygo/config";
import { modelContextBudget } from "./model-context-budget.js";

// Exact versioned descriptor: these fields are part of the execution key,
// never a claim that native tool charges can already be accepted.
export const maximumWebSearchCandidateProfile = Object.freeze({
  version: "routerai-native-web-search-candidate-v1",
  instructionsProfile: nativeWebSearchInstructionsProfile,
  engine: "native",
  maxResults: 5,
  transport: "non-streaming",
  billing: "unverified-unbillable",
} as const);

export const maximumWebSearchPostpayTestProfile = Object.freeze({
  version: "routerai-native-web-search-postpay-test-v1",
  instructionsProfile: nativeWebSearchInstructionsProfile,
  engine: "native",
  maxResults: 5,
  transport: "non-streaming",
  billing: "routerai-total-cost-postpay-test-v1",
} as const);

export const maximumWebSearchPostpayProfile = Object.freeze({
  version: "routerai-native-web-search-postpay-v1",
  instructionsProfile: nativeWebSearchInstructionsProfile,
  engine: "native",
  maxResults: 5,
  transport: "non-streaming",
  billing: "routerai-total-cost-postpay-v1",
  completionPolicy: "optional-validated-sources-v1",
  receiptPolicy: "routerai-native-total-cost-postpay-v1",
} as const);

type MaximumWebSearchProfile =
  | typeof maximumWebSearchCandidateProfile
  | typeof maximumWebSearchPostpayTestProfile
  | typeof maximumWebSearchPostpayProfile;

function exactWebSearchProfile(
  value: MaximumWebSearchProfile,
  expected: MaximumWebSearchProfile,
) {
  const entries = Object.entries(expected);
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === entries.length &&
    entries.every(([key, expected]) => Reflect.get(value, key) === expected)
  );
}

export function createAiExecution(
  config: ReturnType<typeof readConfig>,
  policy: AiPolicy,
  modeProfile?: {
    protocol: "responses" | "chat/completions" | "gigachat";
    requestTimeoutMs: number;
    reasoningEffort?: string;
    billingProfile?: { pricingId: string };
    webSearch?: MaximumWebSearchProfile;
  },
): AiExecution {
  validateMaximumWebSearchConfig(config);
  const webSearchCandidate = modeProfile?.webSearch !== undefined;
  const postpayTest =
    config.AI_MAXIMUM_WEB_SEARCH === "routerai_native_postpay_test_v1";
  const postpay = config.AI_MAXIMUM_WEB_SEARCH === "routerai_native_postpay_v1";
  const expectedWebSearch = postpay
    ? maximumWebSearchPostpayProfile
    : postpayTest
      ? maximumWebSearchPostpayTestProfile
      : maximumWebSearchCandidateProfile;
  if (
    webSearchCandidate &&
    (!exactWebSearchProfile(modeProfile.webSearch!, expectedWebSearch) ||
      ![
        "routerai_native_candidate_v1",
        "routerai_native_postpay_test_v1",
        "routerai_native_postpay_v1",
      ].includes(config.AI_MAXIMUM_WEB_SEARCH) ||
      modeProfile.protocol !== "chat/completions" ||
      policy.provider !== "routerai" ||
      policy.model !== "openai/gpt-6.1-sol" ||
      config.ROUTERAI_MODEL !== "openai/gpt-6.1-sol" ||
      config.ROUTERAI_UPSTREAM !== "openai" ||
      config.ROUTERAI_COUNTRY !== "us" ||
      policy.version !==
        (postpay
          ? "ai-mode-route-web-search-postpay-v1"
          : postpayTest
            ? "ai-mode-route-web-search-postpay-test-v1"
            : "ai-mode-route-web-search-candidate-v1"))
  )
    throw new Error(
      postpay
        ? "Native search requires the exact postpay Maximum profile"
        : postpayTest
          ? "Native search requires the exact postpay-test Maximum profile"
          : "Native search requires the exact unbillable Maximum profile",
    );
  const limits = {
    maxInputBytes: config.LLM_MAX_INPUT_BYTES,
    maxOutputTokens: effectiveLlmLimits(config, policy.provider, policy.model)
      .maxOutputTokens,
  };
  let contextBudget: ReturnType<typeof modelContextBudget> | undefined;
  if (config.AI_CONTEXT_STRATEGY === "model_window_memory_v1") {
    const mode =
      (modeProfile?.protocol === "responses" ||
        (modeProfile?.protocol === "chat/completions" && webSearchCandidate)) &&
      policy.provider === "routerai" &&
      policy.model === "openai/gpt-6.1-sol"
        ? "maximum"
        : modeProfile?.protocol === "chat/completions" &&
            policy.provider === "routerai" &&
            policy.model === "deepseek/deepseek-v4-pro-0813"
          ? "balanced"
          : modeProfile?.protocol === "gigachat" &&
              policy.provider === "gigachat" &&
              policy.model === "GigaChat-3-Ultra"
            ? "minimum"
            : null;
    if (!mode) throw new Error("Model-window memory requires a pinned mode");
    contextBudget = modelContextBudget(mode, limits.maxOutputTokens);
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: "ai-reserve-v1",
        policyId: policy.id,
        ...limits,
        ...(modeProfile
          ? {
              modeProfile: {
                ...modeProfile,
                ...(contextBudget ? { contextBudget } : {}),
              },
            }
          : {}),
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

import { readConfig } from "@citygo/config";
import { createAiPolicy } from "./ai-policy.js";
import { createAssistantModes } from "./ai-modes.js";

// Deliberately no provider constructor, DB, file writes or inherited credentials.
// API-scoped launchers may load .env.api; print only the public consent snapshot.
try {
  const memoryContext =
    process.env.AI_CONTEXT_STRATEGY === "model_window_memory_v1";
  const config = readConfig({
    ROUTERAI_MODEL: process.env.ROUTERAI_MODEL,
    ROUTERAI_UPSTREAM: process.env.ROUTERAI_UPSTREAM,
    ROUTERAI_COUNTRY: process.env.ROUTERAI_COUNTRY,
    ROUTERAI_DATA_NOTICE: process.env.ROUTERAI_DATA_NOTICE,
    AI_ASSISTANT_MODES: process.env.AI_ASSISTANT_MODES,
    AI_MODES_DATA_NOTICE: process.env.AI_MODES_DATA_NOTICE,
    AI_MAXIMUM_REASONING_EFFORT: process.env.AI_MAXIMUM_REASONING_EFFORT,
    AI_CONTEXT_STRATEGY: process.env.AI_CONTEXT_STRATEGY,
    GIGACHAT_MODEL: process.env.GIGACHAT_MODEL,
    GIGACHAT_SCOPE: process.env.GIGACHAT_SCOPE,
    // Public policy preview has no spending or transport authority. The new
    // strategy needs a valid config shape, so use fixed, disabled synthetic
    // billing settings instead of reading keys or operational controls.
    ...(memoryContext
      ? {
          LLM_PROVIDER: "disabled",
          LLM_MAX_INPUT_BYTES: "8388608",
          AI_CREDIT_MODE: "routerai_citygo_10x",
          AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
          AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
          AI_REQUEST_COST_LIMIT_MODE: "operator_ceiling",
          AI_MINIMUM_FIXED_FEE: "enabled",
        }
      : {}),
  });
  if (config.AI_ASSISTANT_MODES === "enabled") {
    if (!config.AI_MODES_DATA_NOTICE) throw new Error();
    console.log(JSON.stringify(createAssistantModes(config)!.policy, null, 2));
  } else {
    if (
      !config.ROUTERAI_MODEL ||
      !config.ROUTERAI_UPSTREAM ||
      !config.ROUTERAI_DATA_NOTICE
    )
      throw new Error();
    console.log(
      JSON.stringify(
        createAiPolicy(config, {
          name: "routerai",
          model: config.ROUTERAI_MODEL,
        }),
        null,
        2,
      ),
    );
  }
} catch {
  console.error(
    "Set RouterAI model, upstream and public operator notice; invalid values are hidden",
  );
  process.exitCode = 1;
}

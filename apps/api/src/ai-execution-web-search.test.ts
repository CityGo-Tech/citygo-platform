import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createAssistantModes } from "./ai-modes.js";
import {
  createAiExecution,
  maximumWebSearchCandidateProfile,
  maximumWebSearchPostpayTestProfile,
  maximumWebSearchPostpayProfile,
} from "./ai-execution.js";

const candidateSettings = {
  NODE_ENV: "test",
  LLM_PROVIDER: "routerai",
  AI_ASSISTANT_MODES: "enabled",
  AI_MAXIMUM_WEB_SEARCH: "routerai_native_candidate_v1",
  AI_CONTEXT_STRATEGY: "model_window_memory_v1",
  LLM_MAX_INPUT_BYTES: "8388608",
  GIGACHAT_MODEL: "GigaChat-3-Ultra",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
};

test("Chat Maximum memory requires the exact explicit unbillable native-search descriptor", () => {
  const modes = createAssistantModes(readConfig(candidateSettings))!;
  const maximum = modes.routes.find(({ id }) => id === "maximum")!;
  const profile = {
    protocol: "chat/completions" as const,
    requestTimeoutMs: 60_000,
    reasoningEffort: "medium",
    webSearch: maximumWebSearchCandidateProfile,
  };
  const execution = createAiExecution(maximum.config, maximum.policy, profile);
  assert.deepEqual(execution, maximum.execution);
  for (const changed of [
    { webSearch: undefined },
    { protocol: "responses" as const },
    { webSearch: { ...maximumWebSearchCandidateProfile, maxResults: 6 } },
    { webSearch: { ...maximumWebSearchCandidateProfile, engine: "exa" } },
    {
      webSearch: {
        ...maximumWebSearchCandidateProfile,
        transport: "streaming",
      },
    },
    { webSearch: { ...maximumWebSearchCandidateProfile, billing: "verified" } },
    { webSearch: { ...maximumWebSearchCandidateProfile, extra: true } },
  ])
    assert.throws(
      () =>
        createAiExecution(maximum.config, maximum.policy, {
          ...profile,
          ...changed,
        } as typeof profile),
      /pinned mode|exact unbillable Maximum profile/,
    );
  for (const changed of [
    { ROUTERAI_MODEL: "other" },
    { ROUTERAI_UPSTREAM: "other" },
    { ROUTERAI_COUNTRY: "cn" },
    { AI_MAXIMUM_WEB_SEARCH: "disabled" as const },
  ])
    assert.throws(
      () =>
        createAiExecution(
          { ...maximum.config, ...changed },
          maximum.policy,
          profile,
        ),
      /exact unbillable Maximum profile/,
    );
  for (const changed of [
    { model: "other" },
    { provider: "openai" as const },
    { version: "ai-mode-route-memory-v1" },
  ])
    assert.throws(
      () =>
        createAiExecution(
          maximum.config,
          { ...maximum.policy, ...changed },
          profile,
        ),
      /exact unbillable Maximum profile/,
    );
});

test("enabling a local candidate never makes arbitrary Chat Maximum a model-window route", () => {
  const maximum = createAssistantModes(readConfig(candidateSettings))!
    .routes[0]!;
  assert.throws(
    () =>
      createAiExecution(maximum.config, maximum.policy, {
        protocol: "chat/completions",
        requestTimeoutMs: 60_000,
      }),
    /pinned mode/,
  );
  for (const changed of [
    { NODE_ENV: "production" as const },
    { AI_CREDIT_MODE: "routerai_citygo_10x" as const },
  ])
    assert.throws(
      () =>
        createAiExecution({ ...maximum.config, ...changed }, maximum.policy, {
          protocol: "chat/completions",
          requestTimeoutMs: 60_000,
          webSearch: maximumWebSearchCandidateProfile,
        }),
      /unbillable non-production candidate/,
    );
});

test("postpay-test search has a distinct exact execution descriptor while normal paid memory rules remain", () => {
  const config = readConfig({
    ...candidateSettings,
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_test_v1",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    AI_MINIMUM_FIXED_FEE: "enabled",
    GIGACHAT_CREDENTIALS: Buffer.from(
      "synthetic-client:synthetic-secret",
    ).toString("base64"),
  });
  const maximum = createAssistantModes(config)!.routes[0]!;
  const profile = {
    protocol: "chat/completions" as const,
    requestTimeoutMs: 60_000,
    reasoningEffort: "medium",
    webSearch: maximumWebSearchPostpayTestProfile,
  };
  assert.equal(
    maximum.policy.version,
    "ai-mode-route-web-search-postpay-test-v1",
  );
  assert.deepEqual(
    createAiExecution(maximum.config, maximum.policy, profile),
    maximum.execution,
  );
  assert.equal(
    maximum.provider,
    undefined,
    "a keyless/config-only test profile cannot generate",
  );
  for (const changed of [
    { webSearch: maximumWebSearchCandidateProfile },
    {
      webSearch: {
        ...maximumWebSearchPostpayTestProfile,
        billing: "unverified-unbillable",
      },
    },
    { protocol: "responses" as const },
    { webSearch: { ...maximumWebSearchPostpayTestProfile, extra: true } },
  ])
    assert.throws(
      () =>
        createAiExecution(maximum.config, maximum.policy, {
          ...profile,
          ...changed,
        } as typeof profile),
      /exact postpay-test Maximum profile/,
    );
  assert.throws(
    () =>
      createAiExecution(
        maximum.config,
        { ...maximum.policy, version: "ai-mode-route-web-search-candidate-v1" },
        profile,
      ),
    /exact postpay-test Maximum profile/,
  );
  assert.throws(
    () =>
      createAiExecution(
        { ...maximum.config, NODE_ENV: "production" },
        maximum.policy,
        profile,
      ),
    /test-only CityGo10x profile/,
  );
});

test("opt-in native postpay binds optional validated completion and full-total receipt semantics in a separate execution", () => {
  const config = readConfig({
    ...candidateSettings,
    AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
    AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
    AI_MINIMUM_FIXED_FEE: "enabled",
    GIGACHAT_CREDENTIALS: Buffer.from(
      "synthetic-client:synthetic-secret",
    ).toString("base64"),
  });
  const maximum = createAssistantModes(config)!.routes[0]!;
  const profile = {
    protocol: "chat/completions" as const,
    requestTimeoutMs: 60_000,
    reasoningEffort: "medium",
    webSearch: maximumWebSearchPostpayProfile,
  };
  assert.deepEqual(
    createAiExecution(maximum.config, maximum.policy, profile),
    maximum.execution,
  );
  assert.equal(maximum.policy.version, "ai-mode-route-web-search-postpay-v1");
  for (const webSearch of [
    maximumWebSearchCandidateProfile,
    maximumWebSearchPostpayTestProfile,
    {
      ...maximumWebSearchPostpayProfile,
      completionPolicy: "required-sources-v1",
    },
    {
      ...maximumWebSearchPostpayProfile,
      receiptPolicy: "routerai-native-total-cost-postpay-test-v1",
    },
    {
      ...maximumWebSearchPostpayProfile,
      instructionsProfile: "routerai-native-web-search-instructions-v1",
    },
    { ...maximumWebSearchPostpayProfile, extra: true },
  ])
    assert.throws(
      () =>
        createAiExecution(maximum.config, maximum.policy, {
          ...profile,
          webSearch,
        } as typeof profile),
      /exact postpay Maximum profile/,
    );
});

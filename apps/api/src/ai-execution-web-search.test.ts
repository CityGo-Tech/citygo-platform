import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { createAssistantModes } from "./ai-modes.js";
import {
  createAiExecution,
  maximumWebSearchCandidateProfile,
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

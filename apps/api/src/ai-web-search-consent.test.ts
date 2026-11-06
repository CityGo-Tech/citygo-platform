import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readConfig } from "@citygo/config";
import { buildServiceConsentPolicy, consentPolicyHash } from "@citygo/db";
import { nativeWebSearchInstructionsProfile } from "@citygo/agents";
import { createAssistantModes } from "./ai-modes.js";
import {
  createAiExecution,
  maximumWebSearchPostpayProfile,
} from "./ai-execution.js";
import { webSearchConsentProfile } from "./ai-web-search-consent.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const v1 = "routerai-native-web-search-instructions-v1";
const v2 = "routerai-native-web-search-instructions-v2";

test("only the reviewed instruction-only v2 change keeps the exact v1 consent representation", () => {
  const actual = webSearchConsentProfile(maximumWebSearchPostpayProfile);
  assert.deepEqual(actual, {
    ...maximumWebSearchPostpayProfile,
    instructionsProfile: v1,
  });
  assert.equal(maximumWebSearchPostpayProfile.instructionsProfile, v2);
  assert.equal(nativeWebSearchInstructionsProfile, v2);
  assert.notStrictEqual(actual, maximumWebSearchPostpayProfile);
  const legacy = Object.freeze({ ...actual });
  assert.strictEqual(webSearchConsentProfile(legacy), legacy);
  assert.deepEqual(webSearchConsentProfile(actual), actual);
});

test("future instruction versions and every other search property remain consent-bound", () => {
  const base = webSearchConsentProfile(maximumWebSearchPostpayProfile);
  const unknown = Object.freeze({
    ...maximumWebSearchPostpayProfile,
    instructionsProfile: "routerai-native-web-search-instructions-v3",
  });
  assert.strictEqual(webSearchConsentProfile(unknown), unknown);
  assert.notEqual(hash(webSearchConsentProfile(unknown)), hash(base));
  for (const [field, changed] of Object.entries({
    version: "different-processing-version",
    engine: "different-search-provider",
    maxResults: 10,
    transport: "streaming",
    billing: "different-billing-profile",
    completionPolicy: "different-sources-policy",
    receiptPolicy: "different-receipt-policy",
    newProcessingField: "must-not-be-dropped",
  })) {
    const profile = { ...maximumWebSearchPostpayProfile, [field]: changed };
    assert.equal(Reflect.get(webSearchConsentProfile(profile), field), changed);
    assert.notEqual(hash(webSearchConsentProfile(profile)), hash(base), field);
  }
});

const settings = {
  NODE_ENV: "test",
  LLM_PROVIDER: "disabled",
  AI_ASSISTANT_MODES: "enabled",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
  AI_MODES_DATA_NOTICE:
    "Synthetic mode recipients, not an approved production notice.",
  AI_MINIMUM_FIXED_FEE: "enabled",
  GIGACHAT_MODEL: "GigaChat-3-Ultra",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  GIGACHAT_CREDENTIALS: Buffer.from(
    "synthetic-client:synthetic-secret",
  ).toString("base64"),
  ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
  AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
  AI_CONTEXT_STRATEGY: "model_window_memory_v1",
  LLM_MAX_INPUT_BYTES: "8388608",
};

test("native factory preserves recorded v1 consent and service snapshot while execution uses v2", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Network forbidden");
  });
  const modes = createAssistantModes(readConfig(settings))!;
  const maximum = modes.routes.find(({ id }) => id === "maximum")!;
  // Recorded from the pinned pre-PR183 factory (288cf966), with these synthetic
  // settings. They are not recomputed from the new normalization helper.
  assert.equal(
    modes.policy.id,
    "8e14be614e3d541908b1e57748de1410ce703f31f9849f1a4691701f61b82d82",
  );
  assert.equal(
    maximum.policy.id,
    "9a94dd7f5c6f7ceb1da7c03a706b9378d95125459a5d0e400148d5c4ab3b57b6",
  );
  const service = buildServiceConsentPolicy(modes.policy);
  assert.equal(
    service.version,
    "v2-ai-f04607edcdaf46812d0bfc8360393892fe6a21b380ff8503d60c08dea5f90897",
  );
  assert.equal(
    consentPolicyHash(service),
    "f910bb28b52c2302fe48fd70333b7f9e8175874a6acb480c299a6c2fcf4a648c",
  );
  assert.notEqual(
    maximum.execution.key,
    "6b9e4bd2933c0cad5750a7d809293ac52f1f2188ed99016484e52ffdd664fdde",
  );
  assert.notEqual(
    modes.catalogId,
    "e45191af9bce8514d192ee217a0a9092c04690933915ac4914ae19e343388efa",
  );
  const executionOptions = {
    protocol: "chat/completions" as const,
    requestTimeoutMs:
      maximum.config.ROUTERAI_REQUEST_TIMEOUT_MS ??
      maximum.config.LLM_REQUEST_TIMEOUT_MS,
    ...(maximum.config.ROUTERAI_REASONING_EFFORT
      ? { reasoningEffort: maximum.config.ROUTERAI_REASONING_EFFORT }
      : {}),
    webSearch: maximumWebSearchPostpayProfile,
  };
  assert.deepEqual(
    maximum.execution,
    createAiExecution(maximum.config, maximum.policy, executionOptions),
  );
  assert.throws(
    () =>
      createAiExecution(maximum.config, maximum.policy, {
        ...executionOptions,
        webSearch: {
          ...maximumWebSearchPostpayProfile,
          instructionsProfile: v1,
        } as unknown as typeof maximumWebSearchPostpayProfile,
      }),
    /exact postpay Maximum profile/,
  );
  assert.equal(
    createAssistantModes({
      ...readConfig(settings),
      NODE_ENV: "production",
      AI_MODES_PRODUCTION_POLICY_ID: modes.policy.id,
    })!.productionApproved,
    true,
  );
  assert.equal(
    createAssistantModes({
      ...readConfig(settings),
      NODE_ENV: "production",
      AI_MODES_PRODUCTION_POLICY_ID: "0".repeat(64),
    })!.productionApproved,
    false,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("changed recipients notice or processing scope still changes consent and service version", () => {
  const modes = createAssistantModes(readConfig(settings))!;
  const service = buildServiceConsentPolicy(modes.policy);
  for (const change of [
    { AI_MODES_DATA_NOTICE: "New recipients and storage conditions." },
    { AI_MAXIMUM_WEB_SEARCH: "disabled" },
  ]) {
    const changed = createAssistantModes(
      readConfig({ ...settings, ...change }),
    )!;
    assert.notEqual(changed.policy.id, modes.policy.id);
    assert.notEqual(
      buildServiceConsentPolicy(changed.policy).version,
      service.version,
    );
  }
});

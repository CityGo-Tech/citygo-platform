import assert from "node:assert/strict";
import test from "node:test";
import {
  serviceConsentPolicy,
  serviceConsentPolicySchema,
  serviceConsentChoiceSchema,
} from "./service-consents.js";

const aiProcessing = {
  id: "a".repeat(64),
  version: "synthetic-ai-v1",
  provider: "routerai",
  model: "synthetic/model",
  recipient: "Synthetic recipient",
  routing: "Synthetic routing notice",
  data: "Synthetic context notice",
};
test("v2 explicitly includes only the disclosed AI recipient and preserves separate optional marketing and SMS choice", () => {
  assert.equal(serviceConsentPolicy.version, "2026-10-25-v2");
  assert.match(serviceConsentPolicy.personalData.text, /внешнему ИИ-сервису/);
  assert.match(
    serviceConsentPolicy.personalData.text,
    /Если сведения.*отсутствуют/,
  );
  assert.match(
    serviceConsentPolicy.personalData.text,
    /по SMS требует отдельного/,
  );
  assert.doesNotMatch(
    serviceConsentPolicy.marketing.text,
    /настройках согласий/,
  );
  assert.equal(serviceConsentPolicy.marketing.required, false);
  assert.equal(serviceConsentPolicy.aiProcessing, undefined);
  assert.deepEqual(
    serviceConsentChoiceSchema.parse({
      policyVersion: serviceConsentPolicy.version,
      personalData: true,
      marketing: false,
    }),
    {
      policyVersion: serviceConsentPolicy.version,
      personalData: true,
      marketing: false,
    },
  );
});
test("effective policy preserves the exact AI disclosure and rejects undisclosed secret fields or invalid recipient identity", () => {
  const policy = { ...serviceConsentPolicy, aiProcessing };
  assert.deepEqual(
    serviceConsentPolicySchema.parse(policy).aiProcessing,
    aiProcessing,
  );
  for (const invalid of [
    { ...aiProcessing, id: "old" },
    { ...aiProcessing, provider: "unknown" },
    { ...aiProcessing, data: "" },
    { ...aiProcessing, apiKey: "synthetic-secret" },
  ])
    assert.equal(
      serviceConsentPolicySchema.safeParse({ ...policy, aiProcessing: invalid })
        .success,
      false,
    );
});

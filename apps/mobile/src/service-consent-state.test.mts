import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard } from "@citygo/api-client";
import { serviceConsentPolicy } from "@citygo/contracts";
import {
  changeServiceConsent,
  createServiceConsentForm,
  currentServiceConsentForm,
  registrationConsentMatchesPolicy,
  serviceConsentChoice,
} from "./service-consent-state.js";

test("native registration requires explicit core consent and leaves marketing optional", () => {
  const scope = { context: "register", signal: new AbortController().signal };
  const empty = createServiceConsentForm(serviceConsentPolicy, scope);
  assert.equal(empty.personalData, false);
  assert.equal(empty.marketing, false);
  assert.equal(serviceConsentChoice(empty, scope), null);
  const marketingFirst = changeServiceConsent(empty, "marketing", true);
  assert.equal(marketingFirst.marketing, true);
  assert.equal(marketingFirst.personalData, false);
  assert.equal(serviceConsentChoice(marketingFirst, scope), null);
  const core = changeServiceConsent(empty, "personalData", true);
  assert.deepEqual(serviceConsentChoice(core, scope), {
    policyVersion: serviceConsentPolicy.version,
    personalData: true,
    marketing: false,
  });
  const both = changeServiceConsent(core, "marketing", true);
  assert.equal(serviceConsentChoice(both, scope)?.marketing, true);
  const unselected = changeServiceConsent(both, "personalData", false);
  assert.equal(unselected.marketing, true);
  assert.equal(serviceConsentChoice(unselected, scope), null);
  assert.equal(
    serviceConsentChoice(
      changeServiceConsent(unselected, "personalData", true),
      scope,
    )?.marketing,
    true,
  );
});

test("a revised policy needs a new choice and cannot inherit either switch", () => {
  const scope = { context: "register", signal: new AbortController().signal };
  const prior = changeServiceConsent(
    createServiceConsentForm(serviceConsentPolicy, scope),
    "personalData",
    true,
  );
  const captured = serviceConsentChoice(prior, scope)!;
  const next = createServiceConsentForm(
    { ...serviceConsentPolicy, version: "next-policy" },
    scope,
  );
  assert.equal(serviceConsentChoice(next, scope), null);
  assert.equal(next.marketing, false);
  assert.equal(captured.policyVersion, serviceConsentPolicy.version);
});

test("choices from another account, auth mode or session cannot be submitted", () => {
  const lifetime = createSessionGuard();
  const scope = { context: "account-a", signal: lifetime.capture().signal };
  const form = changeServiceConsent(
    createServiceConsentForm(serviceConsentPolicy, scope),
    "personalData",
    true,
  );
  assert.equal(
    currentServiceConsentForm(form, { ...scope, context: "account-b" }),
    null,
  );
  assert.equal(
    serviceConsentChoice(form, { ...scope, context: "register" }),
    null,
  );
  lifetime.reset();
  assert.equal(serviceConsentChoice(form, scope), null);
  assert.equal(
    serviceConsentChoice(form, {
      context: "account-a",
      signal: lifetime.capture().signal,
    }),
    null,
  );
});

test("native registration keeps the server's processing snapshot and never substitutes the separate legal policy version", () => {
  const scope = { context: "register", signal: new AbortController().signal };
  const registration = {
    emailVerification: "disabled" as const,
    consentPolicy: {
      ...serviceConsentPolicy,
      version: "synthetic-registration-processing-v2",
      personalData: {
        ...serviceConsentPolicy.personalData,
        text: "Synthetic exact registration processing terms and AI recipient snapshot.",
      },
    },
  };
  const form = changeServiceConsent(
    createServiceConsentForm(registration.consentPolicy, scope),
    "personalData",
    true,
  );
  const choice = serviceConsentChoice(form, scope)!;
  assert.equal(form.policy, registration.consentPolicy);
  assert.equal(
    form.policy.personalData.text,
    registration.consentPolicy.personalData.text,
  );
  assert.equal(choice.policyVersion, registration.consentPolicy.version);
  assert.equal(
    registrationConsentMatchesPolicy(choice, registration.consentPolicy),
    true,
  );
  assert.equal(
    registrationConsentMatchesPolicy(choice, serviceConsentPolicy),
    false,
  );
  assert.equal(choice.marketing, false);
});

test("native registration preflight rejects a changed processing version without changing the captured choices", () => {
  const scope = { context: "register", signal: new AbortController().signal };
  const viewed = {
    ...serviceConsentPolicy,
    version: "synthetic-processing-viewed",
  };
  const next = {
    ...serviceConsentPolicy,
    version: "synthetic-processing-current",
  };
  const selected = changeServiceConsent(
    changeServiceConsent(
      createServiceConsentForm(viewed, scope),
      "personalData",
      true,
    ),
    "marketing",
    true,
  );
  const choice = serviceConsentChoice(selected, scope)!;
  const before = structuredClone(choice);
  assert.equal(registrationConsentMatchesPolicy(choice, next), false);
  assert.deepEqual(choice, before);
  assert.equal(registrationConsentMatchesPolicy(undefined, next), false);
  const fresh = createServiceConsentForm(next, scope);
  assert.equal(serviceConsentChoice(fresh, scope), null);
  assert.equal(fresh.personalData, false);
  assert.equal(fresh.marketing, false);
});

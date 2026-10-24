import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGuard } from "@citygo/api-client";
import { serviceConsentPolicy } from "@citygo/contracts";
import {
  changeServiceConsent,
  createServiceConsentForm,
  currentServiceConsentForm,
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

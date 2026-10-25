// Explicit choices for the disposable smoke accounts only. Never imported by
// application runtime; never grants consent for existing or real accounts.
import assert from "node:assert/strict";

export async function syntheticServiceConsentChoice(request) {
  const response = await request("/api/v1/auth/registration-policy");
  assert.equal(response.status, 200);
  const { consentPolicy: policy } = await response.json();
  assert.equal(typeof policy?.version, "string");
  assert.ok(policy.version.length > 0);
  assert.equal(policy.personalData.required, true);
  assert.equal(policy.marketing.required, false);
  return {
    policyVersion: policy.version,
    personalData: true,
    marketing: false,
  };
}

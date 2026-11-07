import assert from "node:assert/strict";
import test from "node:test";
import { landingAttributionSchema } from "./landing-attribution.js";
import { registrationWithConsentsSchema } from "./service-consents.js";

test("landing attribution contains only a known version and bounded ASCII campaign slugs", () => {
  for (const landingVersion of ["v1", "v8"] as const) {
    const value = {
      landingVersion,
      source: "vk",
      medium: "cpc",
      campaignId: "moscow-20261107",
      content: "decision_1.1",
    };
    assert.deepEqual(landingAttributionSchema.parse(value), value);
    assert.deepEqual(landingAttributionSchema.parse({ landingVersion }), {
      landingVersion,
    });
    assert.equal(
      landingAttributionSchema.safeParse({
        landingVersion,
        content: "a".repeat(80),
      }).success,
      true,
    );
  }
  for (const invalid of [null, undefined, [], {}, { landingVersion: "v2" }])
    assert.equal(landingAttributionSchema.safeParse(invalid).success, false);
  for (const key of ["source", "medium", "campaignId", "content"])
    for (const value of [
      "",
      "a".repeat(81),
      "Upper",
      "Москва",
      "vk ads",
      "vk\n",
      "https://example.test/",
      "?utm_source=vk",
      "a@example.test",
      null,
      123,
      {},
      [],
    ])
      assert.equal(
        landingAttributionSchema.safeParse({
          landingVersion: "v1",
          [key]: value,
        }).success,
        false,
        key + ": " + String(value),
      );
  for (const key of [
    "url",
    "referrer",
    "rawQuery",
    "userId",
    "role",
    "consents",
    "email",
  ])
    assert.equal(
      landingAttributionSchema.safeParse({
        landingVersion: "v8",
        [key]: "synthetic",
      }).success,
      false,
    );
});

test("old registration clients can omit attribution; explicit null and extra metadata are rejected", () => {
  const old = {
    email: "synthetic@example.test",
    password: "synthetic-password",
    consents: {
      policyVersion: "synthetic-v1",
      personalData: true,
      marketing: false,
    },
  };
  assert.deepEqual(registrationWithConsentsSchema.parse(old), old);
  const attributed = { ...old, landingAttribution: { landingVersion: "v8" } };
  assert.deepEqual(
    registrationWithConsentsSchema.parse(attributed),
    attributed,
  );
  for (const landingAttribution of [null, { landingVersion: "v1", url: "/" }])
    assert.equal(
      registrationWithConsentsSchema.safeParse({ ...old, landingAttribution })
        .success,
      false,
    );
});

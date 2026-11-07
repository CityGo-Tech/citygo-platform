import assert from "node:assert/strict";
import test from "node:test";
import {
  landingAttributionFromSearch,
  parseLandingCookie,
  landingCookie,
  parseLandingTouch,
  landingTouchMaxAge,
} from "./landing-attribution";

test("campaign attribution extracts only bounded campaign slugs; contact, URL, term and unknown fields are discarded", () => {
  const value = landingAttributionFromSearch(
    "v1",
    new URLSearchParams({
      utm_source: "VK",
      utm_medium: "cpc",
      utm_campaign: "moscow_family-123",
      utm_content: "private@example.test",
      utm_term: "private search phrase",
      email: "private@example.test",
      returnTo: "https://evil.test/",
    }),
  );
  assert.deepEqual(value, {
    landingVersion: "v1",
    source: "vk",
    medium: "cpc",
    campaignId: "moscow_family-123",
  });
  for (const bad of [
    "a".repeat(81),
    "https://example.test",
    "phone+79990000000",
    "семья",
    "two words",
    "\nsecret",
  ]) {
    assert.deepEqual(
      landingAttributionFromSearch(
        "v8",
        new URLSearchParams({ utm_campaign: bad }),
      ),
      { landingVersion: "v8" },
    );
  }
  assert.deepEqual(
    landingAttributionFromSearch(
      "v8",
      new URLSearchParams("utm_source=vk&utm_source=avito&landing=v1"),
    ),
    { landingVersion: "v8" },
  );
});

test("public example navigation accepts only a fresh same-variant bounded session touch", () => {
  const now = 2_000_000_000_000;
  const touch = {
    at: now - 1,
    attribution: { landingVersion: "v8", source: "vk", campaignId: "work-123" },
  };
  assert.deepEqual(parseLandingTouch(JSON.stringify(touch), "v8", now), touch);
  assert.equal(parseLandingTouch(JSON.stringify(touch), "v1", now), undefined);
  for (const item of [
    { ...touch, at: now + 1 },
    { ...touch, at: now - landingTouchMaxAge },
    { ...touch, at: "yesterday" },
    { ...touch, email: "private@example.test" },
    {
      ...touch,
      attribution: { ...touch.attribution, email: "private@example.test" },
    },
    {
      ...touch,
      attribution: { landingVersion: "v8", campaignId: "https://evil.test" },
    },
  ])
    assert.equal(parseLandingTouch(JSON.stringify(item), "v8", now), undefined);
  for (const raw of [null, "", "invalid", "null", "[]", "x".repeat(2000)])
    assert.equal(parseLandingTouch(raw, "v8", now), undefined);
});

test("registration bridge parses only its own bounded strict cookie and fails open to normal registration", () => {
  const value = {
    landingVersion: "v8",
    source: "avito",
    campaignId: "test-123",
  };
  const cookie = `${landingCookie}=${encodeURIComponent(JSON.stringify(value))}`;
  assert.deepEqual(
    parseLandingCookie("unrelated=value; " + cookie + "; another=1"),
    value,
  );
  for (const raw of [
    "",
    `${landingCookie}=bad-json`,
    cookie + "; " + cookie,
    `${landingCookie}=${encodeURIComponent(JSON.stringify({ ...value, email: "private@example.test" }))}`,
    `${landingCookie}=${encodeURIComponent(JSON.stringify({ ...value, landingVersion: "admin" }))}`,
    "x".repeat(20_000),
  ])
    assert.equal(parseLandingCookie(raw), undefined);
});

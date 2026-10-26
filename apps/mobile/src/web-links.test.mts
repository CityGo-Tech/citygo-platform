import assert from "node:assert/strict";
import test from "node:test";
import { defaultMobileWebUrl, mobileWebDestination } from "./web-links.js";

test("native legal and registration links use Web rather than the direct API origin", () => {
  for (const web of [
    "http://localhost:3000",
    "http://10.0.2.2:3000",
    "http://192.168.1.40:3000",
    "https://pilot.xn--c1ajazlh.xn--p1ai",
    "https://web.example.test/",
  ]) {
    assert.equal(
      mobileWebDestination(web, "/legal/personal-data-consent"),
      new URL(web).origin + "/legal/personal-data-consent",
    );
    assert.equal(mobileWebDestination(web, ""), new URL(web).origin + "/");
  }
  assert.equal(
    mobileWebDestination(defaultMobileWebUrl, "/legal/personal-data-consent"),
    "https://app.xn--c1ajazlh.xn--p1ai/legal/personal-data-consent",
  );
});

test("native Web links reject unsafe origins, credentials and off-origin document paths", () => {
  for (const web of [
    "",
    "/api",
    "javascript:alert(1)",
    "file:///private",
    "data:text/html,test",
    "https://user:secret@example.test",
    "https://example.test?token=secret",
    "https://example.test/#token",
    "https://example.test/api",
  ])
    assert.throws(() =>
      mobileWebDestination(web, "/legal/personal-data-consent"),
    );
  for (const path of [
    "//other.example.test/",
    "https://other.example.test/",
    "/../admin",
    "/api/v1/dashboard",
  ])
    assert.throws(() => mobileWebDestination("https://web.example.test", path));
});

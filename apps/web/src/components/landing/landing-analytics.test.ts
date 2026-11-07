import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsLocationAllowed,
  contentFreeParams,
  createProductAnalytics,
  createRegistrationProductFlow,
  type YandexMetrika,
} from "../product-analytics";

const origin = "https://pilot.xn--c1ajazlh.xn--p1ai";
test("only exact public landing routes and public anchors extend the collector allowlist", () => {
  for (const pathname of ["/landing/v1", "/landing/v8"]) {
    assert.equal(
      analyticsLocationAllowed({ origin, pathname, search: "", hash: "" }),
      true,
    );
    assert.equal(
      analyticsLocationAllowed({ origin, pathname, search: "", hash: "#faq" }),
      true,
    );
    assert.equal(
      analyticsLocationAllowed({
        origin,
        pathname,
        search: "",
        hash: pathname.endsWith("v1") ? "#v1-top" : "#v8-top",
      }),
      true,
    );
    assert.equal(
      analyticsLocationAllowed({
        origin,
        pathname,
        search: "?email=private@test.ru",
        hash: "",
      }),
      false,
    );
    assert.equal(
      analyticsLocationAllowed({
        origin,
        pathname,
        search: "",
        hash: "#private-message",
      }),
      false,
    );
  }
  for (const pathname of [
    "/landing/start",
    "/landing/private",
    "/landing/v1/",
    "/admin",
  ]) {
    assert.equal(
      analyticsLocationAllowed({ origin, pathname, search: "", hash: "" }),
      false,
    );
  }
});

test("landing metrics distinguish the actual landing URL and allowlisted version without campaign strings", () => {
  const commands: unknown[][] = [];
  const send: YandexMetrika = (...args) => commands.push(args);
  const tracker = createProductAnalytics(
    { enabled: true, counterId: 113847047, webvisor: true },
    send,
    { origin, pathname: "/landing/v8", search: "", hash: "" },
    "v8",
  );
  assert.equal(tracker.start(), true);
  tracker.view("landing");
  tracker.event("landing_viewed", { surface: "landing" });
  assert.deepEqual(commands[1], [
    113847047,
    "hit",
    origin + "/landing/v8",
    {
      title: "CityGo",
      referer: "",
      params: { surface: "landing", landingVersion: "v8" },
    },
  ]);
  assert.deepEqual(commands[2], [
    113847047,
    "reachGoal",
    "citygo_landing_viewed",
    { surface: "landing", landingVersion: "v8" },
  ]);
  assert.equal(
    contentFreeParams({ landingVersion: "v1", email: "private@example.test" }),
    null,
  );
  assert.equal(contentFreeParams({ landingVersion: "other" }), null);
  assert.equal(
    createProductAnalytics(
      { enabled: true, counterId: 113847047, webvisor: true },
      send,
      { origin, pathname: "/landing/v8", search: "", hash: "" },
      "private" as never,
    ).start(),
    false,
  );
});

test("the observed registration flow freezes version through OTP and owner transfer, then drops it on cancellation", () => {
  const flow = createRegistrationProductFlow();
  const first = new AbortController(),
    next = new AbortController();
  const handle = flow.begin(first.signal, "v1")!;
  assert.equal(flow.landingVersion(handle), "v1");
  flow.codeSent(handle, "123e4567-e89b-42d3-a456-426614174001", first.signal);
  assert.equal(
    flow.prepare(
      handle,
      { id: "42", role: "user" },
      first.signal,
      "123e4567-e89b-42d3-a456-426614174001",
    ),
    handle,
  );
  first.abort();
  assert.equal(flow.transfer(handle, "42", next.signal), true);
  assert.deepEqual(
    flow.pending(next.signal, "42").map((x) => x.landingVersion),
    ["v1", "v1"],
  );
  assert.deepEqual(flow.pending(next.signal, "43"), []);
  flow.clear();
  assert.equal(flow.landingVersion(handle), undefined);
  assert.equal(flow.begin(next.signal, "private" as never), null);
});

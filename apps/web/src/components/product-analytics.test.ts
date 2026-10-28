import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsLocationAllowed,
  analyticsReferrerAllowed,
  connectProductAnalytics,
  contentFreeParams,
  createProductAnalytics,
  isAnalyticsIdentity,
  parseProductAnalyticsConfig,
  productEvents,
  trackProductEvent,
  whenAnalyticsIdentityReady,
  type YandexMetrika,
} from "./product-analytics";

const location = {
  origin: "https://pilot.xn--c1ajazlh.xn--p1ai",
  pathname: "/",
  search: "",
  hash: "",
};
const enabled = {
  enabled: true,
  counterId: 105736701,
  webvisor: true,
};
function fixture(config = enabled, url = location) {
  const calls: unknown[][] = [];
  const send: YandexMetrika = (...args) => calls.push(args);
  return { calls, tracker: createProductAnalytics(config, send, url) };
}

test("public analytics is disabled unless exact flags and a positive counter are configured", () => {
  assert.deepEqual(parseProductAnalyticsConfig({}), {
    enabled: false,
    counterId: null,
    webvisor: false,
  });
  for (const counterId of ["", "0", "-1", "1.5", "123?token=private", "1e8"])
    assert.equal(
      parseProductAnalyticsConfig({ enabled: "enabled", counterId }).enabled,
      false,
    );
  assert.equal(
    parseProductAnalyticsConfig({ enabled: "true", counterId: "105736701" })
      .enabled,
    false,
  );
  const f = fixture({ ...enabled, enabled: false });
  assert.equal(f.tracker.start(), false);
  assert.equal(f.tracker.event("landing_viewed"), false);
  assert.equal(f.tracker.view("landing"), false);
  assert.deepEqual(f.calls, []);
});

test("admin, recovery, query/hash URLs, localhost and private incoming referrers cannot load the collector", () => {
  for (const pathname of [
    "/admin",
    "/login",
    "/checkout",
    "/api/ready",
    "/legal",
  ])
    assert.equal(analyticsLocationAllowed({ ...location, pathname }), false);
  assert.equal(
    analyticsLocationAllowed({ ...location, origin: "http://localhost:3000" }),
    false,
  );
  for (const search of ["?email=a@b.ru", "?utm_source=ad", "?token=secret"])
    assert.equal(analyticsLocationAllowed({ ...location, search }), false);
  assert.equal(
    analyticsLocationAllowed({ ...location, hash: "#message-123" }),
    false,
  );
  assert.equal(analyticsReferrerAllowed(""), true);
  assert.equal(analyticsReferrerAllowed(location.origin + "/"), true);
  for (const value of [
    "https://mail.example/message/private",
    location.origin + "/?email=private@example.ru",
    location.origin + "/#otp-secret",
    "https://user:password@pilot.xn--c1ajazlh.xn--p1ai/",
  ])
    assert.equal(analyticsReferrerAllowed(value), false);
});

test("initialization disables automatic URLs, titles, link tracking, ecommerce and tag manager", () => {
  const f = fixture();
  assert.equal(f.tracker.start(), true);
  assert.equal(f.tracker.start(), true);
  assert.equal(f.calls.length, 1);
  const init = f.calls[0]![2] as Record<string, unknown>;
  assert.equal(init.defer, true);
  assert.equal(init.sendTitle, false);
  assert.equal(init.trackLinks, false);
  assert.equal(init.trackHash, false);
  assert.equal(init.ecommerce, false);
  assert.equal(init.childIframe, false);
  assert.equal(init.disableYtm, true);
  assert.equal(init.webvisor, true);
});

test("only purpose-separated opaque IDs can correlate an account with the collector", () => {
  const identity = "cga_" + "a".repeat(64);
  assert.equal(isAnalyticsIdentity(identity), true);
  for (const value of [
    "1",
    "user@example.ru",
    "+79991234567",
    "a".repeat(64),
  ]) {
    const f = fixture();
    assert.equal(f.tracker.start(value), false);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.tracker.start(identity);
  assert.deepEqual(f.calls.at(-1), [105736701, "setUserID", identity]);
});

test("goals reject unrecognized events, arbitrary data and values containing private content", () => {
  const f = fixture();
  f.tracker.start();
  for (const input of [
    { email: "private@example.ru" },
    { text: "private message" },
    { surface: "private@example.ru" },
    { assistant: "https://checkout.example/private" },
    { mode: "provider/private-model" },
    { surface: "chat", password: "private" },
  ]) {
    assert.equal(contentFreeParams(input), null);
    assert.equal(f.tracker.event("assistant_opened", input as never), false);
  }
  assert.equal(f.tracker.event("private-message" as never), false);
  assert.equal(f.calls.length, 1);
  for (const name of productEvents)
    assert.equal(
      f.tracker.event(name, { surface: "chat", mode: "balanced" }),
      true,
    );
  assert(
    f.calls.slice(1).every((row) => (row[2] as string).startsWith("citygo_")),
  );
});

test("SPA screen transitions have static URLs/referrers and do not duplicate the current screen", () => {
  const f = fixture();
  f.tracker.start();
  assert.equal(f.tracker.view("chat"), true);
  assert.equal(f.tracker.view("chat"), false);
  assert.equal(f.tracker.view("phone"), true);
  assert.equal(f.tracker.view("private@example.ru" as never), false);
  assert.deepEqual(f.calls.at(-1), [
    105736701,
    "hit",
    location.origin + "/",
    { title: "CityGo", referer: "", params: { surface: "phone" } },
  ]);
});

test("transaction correlation keys are memory-only, deduplicate outcomes and are never transmitted", () => {
  const f = fixture();
  f.tracker.start();
  const key = "private-correlation-not-for-provider";
  assert.equal(f.tracker.event("payment_credited", {}, key), true);
  assert.equal(f.tracker.event("payment_credited", {}, key), false);
  assert.equal(JSON.stringify(f.calls).includes(key), false);
  f.tracker.stop();
  assert.equal(f.tracker.event("payment_credited", {}, key), false);
  assert.equal(f.tracker.view("wallet"), false);
  assert.deepEqual(f.calls.at(-1), [105736701, "destruct"]);
});

test("collector exceptions and detached event sinks never break app actions or revive a departed owner", () => {
  const broken = createProductAnalytics(
    enabled,
    () => {
      throw new Error("collector blocked");
    },
    location,
  );
  assert.equal(broken.start(), false);
  assert.doesNotThrow(() => broken.stop());
  const calls: string[] = [];
  const releaseOld = connectProductAnalytics((event) =>
    calls.push("old:" + event),
  );
  const releaseNew = connectProductAnalytics((event) =>
    calls.push("new:" + event),
  );
  releaseOld();
  trackProductEvent("wallet_opened");
  releaseNew();
  trackProductEvent("phone_opened");
  assert.deepEqual(calls, ["new:wallet_opened"]);
  const releaseBroken = connectProductAnalytics(() => {
    throw new Error("tracking unavailable");
  });
  assert.doesNotThrow(() => trackProductEvent("wallet_opened"));
  releaseBroken();
});

test("logout, opt-out or admin navigation during identity lookup cannot start a collector", async () => {
  for (const reason of ["logout", "opt-out", "admin"]) {
    let resolve!: (identity: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    let allowed = true;
    const started: unknown[] = [];
    const work = whenAnalyticsIdentityReady(
      () => pending,
      () => allowed,
      (identity) => started.push(identity),
    );
    allowed = false;
    resolve("cga_" + "a".repeat(64));
    await work;
    assert.deepEqual(started, [], reason);
  }
  let lookups = 0;
  await whenAnalyticsIdentityReady(
    async () => {
      lookups++;
      return null;
    },
    () => false,
    () => assert.fail("disabled collector started"),
  );
  assert.equal(lookups, 0);
  await whenAnalyticsIdentityReady(
    async () => "private@example.ru",
    () => true,
    () => assert.fail("private identity started a collector"),
  );
});

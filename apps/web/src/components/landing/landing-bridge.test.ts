import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET } from "../../app/landing/start/route";

test("the bridge uses a fixed query-free relative redirect behind standalone and forwarded hosts", () => {
  for (const origin of [
    "http://0.0.0.0:3000",
    "http://localhost:3000",
    "https://pilot.example.test",
  ]) {
    const response = GET(
      new NextRequest(
        origin +
          "/landing/start?landing=v1&utm_source=vk&returnTo=https%3A%2F%2Fevil.test%2F&email=private%40example.test",
        {
          headers: {
            host: "untrusted.example",
            "x-forwarded-host": "evil.test",
            "x-forwarded-proto": "http",
          },
        },
      ),
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(
      JSON.parse(response.cookies.get("citygo_landing_attribution")!.value),
      { landingVersion: "v1", source: "vk" },
    );
  }
});

test("bridge privacy headers expire prior attribution while retaining the one-use login intent", () => {
  for (const header of ["DNT", "Sec-GPC"]) {
    const response = GET(
      new NextRequest(
        "https://pilot.example.test/landing/start?intent=login&landing=v8&utm_source=vk",
        { headers: { [header]: "1" } },
      ),
    );
    assert.equal(response.headers.get("location"), "/");
    assert.equal(response.cookies.get("citygo_landing_attribution")!.maxAge, 0);
    assert.equal(response.cookies.get("citygo_landing_intent")!.value, "login");
  }
});

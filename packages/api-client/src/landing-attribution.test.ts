import assert from "node:assert/strict";
import test from "node:test";
import type { LandingAttribution } from "@citygo/contracts";
import { createClient } from "./index.js";

test("optional campaign metadata reaches only registration bodies; old clients and login keep the old wire shape", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const attribution: LandingAttribution = {
    landingVersion: "v8",
    source: "vk",
    campaignId: "synthetic-launch",
  };
  const consents = {
    policyVersion: "synthetic-v1",
    personalData: true as const,
    marketing: false,
  };
  const client = createClient("http://synthetic", {
    fetch: async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json(
        String(url).endsWith("/email/register")
          ? {
              challengeId: "a274d301-c0e2-4e4a-b0f4-4bf8a513ff64",
              proof: "ab".repeat(32),
              expiresAt: "2099-01-01T12:00:00.000Z",
              resendAfterSeconds: 60,
            }
          : { user: { id: "1", email: "synthetic@example.test" } },
      );
    },
  });
  await client.beginEmailRegistration(
    "synthetic@example.test",
    "synthetic-password",
    consents,
  );
  await client.beginEmailRegistration(
    "synthetic@example.test",
    "synthetic-password",
    consents,
    attribution,
  );
  await client.auth(
    "register",
    "synthetic@example.test",
    "synthetic-password",
    consents,
    attribution,
  );
  await client.auth(
    "login",
    "synthetic@example.test",
    "synthetic-password",
    undefined,
    attribution,
  );
  const oldBody = {
    email: "synthetic@example.test",
    password: "synthetic-password",
    consents,
  };
  assert.deepEqual(
    calls.map((c) => c.body),
    [
      oldBody,
      { ...oldBody, landingAttribution: attribution },
      { ...oldBody, landingAttribution: attribution },
      { email: oldBody.email, password: oldBody.password },
    ],
  );
  const before = calls.length;
  await assert.rejects(
    client.beginEmailRegistration(oldBody.email, oldBody.password, consents, {
      landingVersion: "v8",
      url: "https://example.test/private",
    } as unknown as LandingAttribution),
  );
  assert.equal(calls.length, before);
});

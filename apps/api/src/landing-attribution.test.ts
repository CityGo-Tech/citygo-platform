import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { connectDatabase, migrate } from "@citygo/db";
import { readConfig } from "@citygo/config";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import { syntheticServiceConsents } from "./test-service-consents.js";
import { buildApp } from "./app.js";

const attribution = {
  landingVersion: "v8",
  source: "vk",
  medium: "cpc",
  campaignId: "synthetic-launch",
  content: "decision",
};
async function fixture(t: TestContext, required: boolean) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let lastCode = "";
  let deliveries = 0;
  const app = await buildApp({
    db,
    testing: true,
    config: readConfig({
      NODE_ENV: "test",
      LLM_PROVIDER: "disabled",
      EMAIL_REGISTRATION_MODE: required ? "required" : "disabled",
      EMAIL_REGISTRATION_SECRET: "a".repeat(64),
    }),
    ...(required
      ? {
          emailRegistrationDelivery: async ({ code }: { code: string }) => {
            lastCode = code;
            deliveries++;
          },
        }
      : {}),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const post = (url: string, payload: unknown, cookie?: string) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        origin: "http://localhost:3000",
        [CONTRACT_VERSION_HEADER]: "1",
        ...(cookie ? { cookie } : {}),
      },
      payload: payload as object,
    });
  return { db, app, post, code: () => lastCode, deliveries: () => deliveries };
}
const registration = (suffix: string) => ({
  email: `synthetic-${suffix}@example.test`,
  password: "synthetic-password",
  consents: syntheticServiceConsents,
});

test("OTP wire preserves campaign metadata, binds it only after verification, and rejects attempts to relabel during confirmation/login", async (t) => {
  const f = await fixture(t, true);
  const request = {
    ...registration("campaign"),
    landingAttribution: attribution,
  };
  const start = await f.post("/v1/auth/email/register", request);
  assert.equal(start.statusCode, 200);
  assert.deepEqual(
    (
      await f.db.query<{ landing_attribution: unknown }>(
        "select landing_attribution from email_registrations",
      )
    ).rows[0]?.landing_attribution,
    attribution,
  );
  assert.equal(
    (await f.db.query("select 1 from user_acquisition")).rows.length,
    0,
  );
  const challenge = start.json<{ challengeId: string; proof: string }>();
  const confirmation = { ...challenge, code: f.code() };
  // Only capability/proof/code are confirm fields, never new campaign labels.
  const { challengeId, proof, code } = confirmation;
  assert.equal(
    (
      await f.post("/v1/auth/email/confirm", {
        challengeId,
        proof,
        code,
        landingAttribution: { landingVersion: "v1" },
      })
    ).statusCode,
    400,
  );
  const completed = await f.post("/v1/auth/email/confirm", {
    challengeId,
    proof,
    code,
  });
  assert.equal(completed.statusCode, 200);
  const user = completed.json<{ user: { id: string; role: string } }>().user;
  assert.equal(user.role, "user");
  const rows = () =>
    f.db.query(
      "select user_id::text,landing_attribution from user_acquisition",
    );
  assert.deepEqual((await rows()).rows, [
    { user_id: user.id, landing_attribution: attribution },
  ]);
  assert.equal(
    (await f.post("/v1/auth/email/confirm", { challengeId, proof, code }))
      .statusCode,
    400,
  );
  await f.post("/v1/auth/login", {
    email: request.email,
    password: request.password,
    landingAttribution: { landingVersion: "v1" },
  });
  assert.deepEqual((await rows()).rows, [
    { user_id: user.id, landing_attribution: attribution },
  ]);
  const sources = (
    await f.db.query<{ source: string }>(
      "select distinct source from service_consent_events",
    )
  ).rows;
  assert.deepEqual(sources, [{ source: "email-registration" }]);
});

test("legacy registration accepts optional metadata; URL/contact/identity extras fail before a send or user creation", async (t) => {
  for (const required of [false, true]) {
    const f = await fixture(t, required);
    const endpoint = required ? "/v1/auth/email/register" : "/v1/auth/register";
    for (const landingAttribution of [
      null,
      { landingVersion: "v1", referrer: "https://example.test/private" },
      { landingVersion: "v8", source: "person@example.test" },
      { landingVersion: "v8", userId: "1" },
      { landingVersion: "v8", campaignId: "x\n" },
    ])
      assert.equal(
        (
          await f.post(endpoint, {
            ...registration("invalid"),
            landingAttribution,
          })
        ).statusCode,
        400,
      );
    assert.equal(f.deliveries(), 0);
    assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
    const sent = await f.post(endpoint, {
      ...registration("valid"),
      landingAttribution: { landingVersion: "v1", content: "family" },
    });
    assert.equal(sent.statusCode, 200);
    if (!required) {
      assert.deepEqual(
        (
          await f.db.query<{ landing_attribution: unknown }>(
            "select landing_attribution from user_acquisition",
          )
        ).rows,
        [{ landing_attribution: { landingVersion: "v1", content: "family" } }],
      );
      const old = await f.post(endpoint, registration("old-client"));
      assert.equal(old.statusCode, 200);
      assert.deepEqual(
        (
          await f.db.query(
            "select 1 from user_acquisition where landing_attribution is null",
          )
        ).rows.length,
        1,
      );
    }
  }
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  AccountAccess,
  ServiceConsents,
} from "@citygo/db";
import {
  serviceConsentPolicy,
  serviceConsentStateSchema,
  registrationPolicyResponseSchema,
} from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import { syntheticServiceConsents } from "./test-service-consents.js";
async function fixture(t: TestContext, required = false) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
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
          emailRegistrationDelivery: async () => {
            deliveries++;
          },
        }
      : {}),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const call = (url: string, payload?: unknown, token?: string) =>
    app.inject({
      method: payload === undefined ? "GET" : "POST",
      url,
      headers: {
        "x-citygo-client": "native",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return { db, app, call, deliveries: () => deliveries };
}
test("public policy supplies two separate exact documents; both signup APIs reject absent, unchecked and stale choices before delivery", async (t) => {
  for (const required of [false, true]) {
    const f = await fixture(t, required);
    const policy = registrationPolicyResponseSchema.parse(
      (await f.call("/v1/auth/registration-policy")).json(),
    );
    assert.deepEqual(policy.consentPolicy, serviceConsentPolicy);
    assert.deepEqual(
      (await f.call("/v1/legal/consent-policy")).json(),
      serviceConsentPolicy,
    );
    const path = required ? "/v1/auth/email/register" : "/v1/auth/register";
    for (const consents of [
      undefined,
      { ...syntheticServiceConsents, personalData: false },
      { policyVersion: serviceConsentPolicy.version, personalData: true },
      { ...syntheticServiceConsents, policyVersion: "old" },
    ]) {
      const response = await f.call(path, {
        email: "invalid@example.test",
        password: "123456",
        ...(consents === undefined ? {} : { consents }),
      });
      assert.equal(
        response.statusCode,
        consents?.policyVersion === "old" ? 409 : 400,
        response.body,
      );
    }
    assert.equal(f.deliveries(), 0);
    for (const table of [
      "users",
      "sessions",
      "email_registrations",
      "service_consent_events",
    ])
      assert.deepEqual((await f.db.query(`select * from ${table}`)).rows, []);
  }
});
test("optional marketing false completes signup; owner can grant/revoke it without losing required service consent", async (t) => {
  const f = await fixture(t);
  const created = await f.call("/v1/auth/register", {
    email: "owner@example.test",
    password: "123456",
    consents: syntheticServiceConsents,
  });
  assert.equal(created.statusCode, 200, created.body);
  const { token, user } = created.json<{
    token: string;
    user: { id: string; serviceConsentRequired: boolean };
  }>();
  assert.equal(user.serviceConsentRequired, false);
  assert.equal(
    (await f.call("/v1/conversations/start", {}, token)).statusCode,
    200,
  );
  assert.equal((await f.call("/v1/account/consents")).statusCode, 401);
  for (const marketing of [true, false]) {
    const updated = await f.call(
      "/v1/account/consents",
      { ...syntheticServiceConsents, marketing },
      token,
    );
    assert.equal(updated.statusCode, 200, updated.body);
    const state = serviceConsentStateSchema.parse(updated.json());
    assert.equal(state.marketingGranted, marketing);
    assert.equal(state.serviceConsentRequired, false);
    assert.equal(
      (await f.call("/v1/conversations", undefined, token)).statusCode,
      200,
    );
  }
  assert.deepEqual(
    (
      await f.db.query(
        "select decision from service_consent_events where purpose='marketing' order by id",
      )
    ).rows,
    [
      { decision: "declined" },
      { decision: "granted" },
      { decision: "withdrawn" },
    ],
  );
});
test("legacy sessions cannot bypass service consent through alternate APIs; dashboard, password and consent recovery stay reachable", async (t) => {
  const f = await fixture(t),
    repo = new Repository(f.db);
  const id = await repo.register(
    "legacy@example.test",
    await hashPassword("123456"),
  );
  await repo.createSession(id, tokenHash("synthetic-legacy-session"));
  const token = "synthetic-legacy-session";
  const board = await f.call("/v1/dashboard", undefined, token);
  assert.equal(board.statusCode, 200);
  assert.equal(board.json().user.serviceConsentRequired, true);
  assert.equal(board.json().thread, null);
  assert.equal(board.json().profile, null);
  const getRoutes = [
    "/v1/conversations",
    "/v1/messages/favorites",
    "/v1/ai/credit",
    "/v1/payments/availability",
    "/v1/payments/sources",
    "/v1/payments/refunds",
    "/v1/payments/receipts",
  ];
  const postRoutes = [
    "/v1/conversations/start",
    "/v1/questionnaire",
    "/v1/ai/consent",
    "/v1/threads/1/messages",
    "/v1/quests/1/start",
    "/v1/quests/1/complete",
    "/v1/phone-verification/start",
  ];
  for (const [path, payload] of [
    ...getRoutes.map((path) => [path, undefined] as const),
    ...postRoutes.map((path) => [path, {}] as const),
  ]) {
    const response = await f.call(path, payload, token);
    assert.equal(response.statusCode, 403, path + ": " + response.body);
    assert.equal(response.json().code, "SERVICE_CONSENT_REQUIRED");
  }
  const current = await f.call("/v1/account/consents", undefined, token);
  assert.equal(current.statusCode, 200);
  assert.equal(current.json().serviceConsentRequired, true);
  const changed = await f.call(
    "/v1/auth/password",
    { currentPassword: "123456", password: "654321" },
    token,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  const newToken = changed.json().token;
  assert.equal(changed.json().user.serviceConsentRequired, true);
  assert.equal(
    (await f.call("/v1/account/consents", syntheticServiceConsents, newToken))
      .statusCode,
    200,
  );
  assert.equal(
    (await f.call("/v1/conversations/start", {}, newToken)).statusCode,
    200,
  );
  assert.equal(
    (await new ServiceConsents(f.db).state(id)).serviceConsentRequired,
    false,
  );
  assert.equal((await f.call("/v1/auth/logout", {}, newToken)).statusCode, 200);
});
test("bootstrap administrator receives no implicit grant even after rotating the temporary password", async (t) => {
  const f = await fixture(t),
    user = await new AccountAccess(f.db).bootstrapAdmin(
      await hashPassword("admin"),
    );
  const login = await f.call("/v1/auth/login", {
    email: "admin",
    password: "admin",
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.serviceConsentRequired, true);
  const changed = await f.call(
    "/v1/auth/password",
    { currentPassword: "admin", password: "123456" },
    login.json().token,
  );
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().user.serviceConsentRequired, true);
  assert.equal(
    (await f.call("/v1/admin/overview", undefined, changed.json().token)).json()
      .code,
    "SERVICE_CONSENT_REQUIRED",
  );
  assert.equal(
    (
      await f.call(
        "/v1/account/consents",
        syntheticServiceConsents,
        changed.json().token,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.call("/v1/admin/overview", undefined, changed.json().token))
      .statusCode,
    200,
  );
  assert.equal(
    (await new ServiceConsents(f.db).state(user.id)).serviceConsentRequired,
    false,
  );
});

import assert from "node:assert/strict";
import { syntheticConsentsFor } from "./test-service-consents.js";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  AccountAccess,
  ClosedAccountRestart,
  Repository,
  connectDatabase,
  migrate,
} from "@citygo/db";
import {
  CONTRACT_VERSION_HEADER,
  adminUsersResponseSchema,
  authResponseSchema,
  dashboardResponseSchema,
} from "@citygo/contracts";
import { readConfig } from "@citygo/config";
import type { ModelStreamEvent, StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import { seedTestBudget } from "./test-budget.js";

class ClosedRestartSyntheticProvider implements StreamingProvider {
  readonly name = "openai" as const;
  readonly model = "test-model";
  calls = 0;
  async *stream(): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    yield { type: "delta", text: "Only synthetic test data" };
    yield { type: "complete", model: this.model };
  }
}

test("closed restart reaches HTTP with revoked legacy identity, restricted admin/admin and mandatory password rotation", async (t) => {
  // No environment files, server URLs, credentials or live model adapters.
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    try {
      await cleanup.app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  const repo = new Repository(db);
  const legacy = await repo.register(
    "retired-api@example.test",
    await hashPassword("legacy-password"),
  );
  const legacyToken = "synthetic-retired-session";
  await repo.createSession(legacy, tokenHash(legacyToken));
  const oldThread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,context) values ($1,'housing','{\"private\":\"PRIVATE-RETIRED-CONTEXT\"}') returning id::text",
      [legacy],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content) values ($1,'user','PRIVATE-RETIRED-CHAT')",
    [oldThread],
  );
  const restart = new ClosedAccountRestart(db);
  const plan = await restart.plan({
    expectedUserCount: 1,
    maintenanceConfirmed: true,
  });
  assert.deepEqual(plan.blockers, []);
  const result = await restart.apply({
    expectedUserCount: 1,
    expectedSnapshotFingerprint: plan.snapshotFingerprint,
    backupReceiptSha256: "b".repeat(64),
    maintenanceConfirmed: true,
    servicesStoppedConfirmed: true,
    retainedAuditsReviewed: true,
    passwordHash: await hashPassword("admin"),
  });
  assert.equal(result.accountsRetired, 1);
  assert.equal(result.accountsDeleted, 0);
  assert.equal(result.publicIngressMayOpen, false);
  assert.equal(JSON.stringify(result).includes("PRIVATE-"), false);

  const provider = new ClosedRestartSyntheticProvider();
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    WEB_ORIGIN: "http://localhost:3000",
    // The old allowlist must not resurrect the retired account's privileges.
    ADMIN_USER_IDS: legacy,
  });
  await seedTestBudget(db, config, { openai: provider });
  const app = await buildApp({ db, provider, testing: true, config });
  cleanup.app = app;
  const call = (
    method: "GET" | "POST",
    url: string,
    token = "",
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  const login = (email: string, password: string) =>
    call("POST", "/v1/auth/login", "", { email, password });

  const retiredLogin = await login(
    "retired-api@example.test",
    "legacy-password",
  );
  assert.equal(retiredLogin.statusCode, 401, retiredLogin.body);
  const retiredSession = await call("GET", "/v1/dashboard", legacyToken);
  assert.equal(retiredSession.statusCode, 401, retiredSession.body);
  assert.equal(
    (await call("GET", "/v1/admin/overview", legacyToken)).statusCode,
    401,
  );

  const initial = await login("admin", "admin");
  assert.equal(initial.statusCode, 200, initial.body);
  const initialAuth = authResponseSchema.parse(initial.json());
  assert.equal(initialAuth.user.username, "admin");
  assert.equal(initialAuth.user.role, "super_admin");
  assert.equal(initialAuth.user.mustChangePassword, true);
  assert.notEqual(initialAuth.user.id, legacy);
  assert.ok(initialAuth.token);
  const temporaryToken = initialAuth.token;
  const secondLogin = await login("admin", "admin");
  assert.equal(secondLogin.statusCode, 200, secondLogin.body);
  const secondTemporaryToken = authResponseSchema.parse(
    secondLogin.json(),
  ).token;
  assert.ok(secondTemporaryToken);

  const initialDashboard = await call("GET", "/v1/dashboard", temporaryToken);
  assert.equal(initialDashboard.statusCode, 200, initialDashboard.body);
  const board = dashboardResponseSchema.parse(initialDashboard.json());
  assert.equal(board.user.mustChangePassword, true);
  assert.equal(board.profile, null);
  assert.equal(board.thread, null);
  assert.deepEqual(board.quests, []);
  const denied = [
    await call("GET", "/v1/admin/accounts", temporaryToken),
    await call("GET", "/v1/admin/overview", temporaryToken),
    await call("POST", "/v1/conversations/start", temporaryToken, {}),
    await call("POST", "/v1/ai/consent", temporaryToken, { action: "revoked" }),
    await call("POST", `/v1/threads/${oldThread}/messages`, temporaryToken, {
      text: "Вымышленный вопрос",
      requestId: randomUUID(),
    }),
  ];
  assert.deepEqual(
    denied.map((response) => response.statusCode),
    [403, 403, 403, 403, 403],
  );
  assert.equal(provider.calls, 0);

  const tooShort = await call("POST", "/v1/auth/password", temporaryToken, {
    currentPassword: "admin",
    password: "12345",
  });
  assert.equal(tooShort.statusCode, 400, tooShort.body);
  const changed = await call("POST", "/v1/auth/password", temporaryToken, {
    currentPassword: "admin",
    password: "123456",
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const currentAuth = authResponseSchema.parse(changed.json());
  assert.ok(currentAuth.token);
  assert.equal(currentAuth.user.role, "super_admin");
  assert.equal(currentAuth.user.mustChangePassword, false);
  assert.notEqual(currentAuth.token, temporaryToken);
  for (const obsolete of [legacyToken, temporaryToken, secondTemporaryToken]) {
    const reply = await call("GET", "/v1/dashboard", obsolete);
    assert.equal(reply.statusCode, 401, reply.body);
  }
  assert.equal((await login("admin", "admin")).statusCode, 401);
  const relogin = await login("admin", "123456");
  assert.equal(relogin.statusCode, 200, relogin.body);
  const reloginAuth = authResponseSchema.parse(relogin.json());
  assert.ok(reloginAuth.token);
  assert.equal(reloginAuth.user.mustChangePassword, false);
  assert.equal(reloginAuth.user.role, "super_admin");
  assert.equal(reloginAuth.user.serviceConsentRequired, true);
  const needsConsent = await call(
    "GET",
    "/v1/admin/accounts",
    currentAuth.token,
  );
  assert.equal(needsConsent.statusCode, 403);
  assert.equal(needsConsent.json().code, "SERVICE_CONSENT_REQUIRED");
  const accepted = await call(
    "POST",
    "/v1/account/consents",
    currentAuth.token,
    await syntheticConsentsFor(app),
  );
  assert.equal(accepted.statusCode, 200, accepted.body);

  const listing = await call("GET", "/v1/admin/accounts", currentAuth.token);
  assert.equal(listing.statusCode, 200, listing.body);
  const users = adminUsersResponseSchema.parse(listing.json()).users;
  assert.deepEqual(
    users.map((user) => user.id),
    [currentAuth.user.id],
  );
  assert.equal(
    (await call("GET", "/v1/admin/overview", reloginAuth.token)).statusCode,
    200,
  );
  const started = await call(
    "POST",
    "/v1/conversations/start",
    currentAuth.token,
    {},
  );
  assert.equal(started.statusCode, 200, started.body);
  assert.notEqual(started.json<{ id: string }>().id, oldThread);
  assert.equal(started.json<{ agentKey: string }>().agentKey, "support");
  const finalDashboard = await call("GET", "/v1/dashboard", currentAuth.token);
  assert.equal(finalDashboard.statusCode, 200, finalDashboard.body);
  const finalBoard = dashboardResponseSchema.parse(finalDashboard.json());
  assert.deepEqual(finalBoard.thread?.messages, []);
  assert.equal(finalDashboard.body.includes("PRIVATE-RETIRED-"), false);
  assert.equal((await db.query("select 1 from messages")).rows.length, 0);
  assert.equal(
    await new AccountAccess(db).credentials("retired-api@example.test"),
    undefined,
  );
  assert.equal(
    provider.calls,
    0,
    "This entire HTTP transition must not invoke any model",
  );
});

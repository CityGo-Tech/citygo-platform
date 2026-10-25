import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  consentPolicyHash,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import {
  CONTRACT_VERSION_HEADER,
  serviceConsentPolicy,
  type Dashboard,
  type ServiceConsentPolicy,
} from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { hashPassword, tokenHash } from "./auth.js";
import { seedTestBudget } from "./test-budget.js";

async function fixture(t: TestContext, emailRequired = false) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  let calls = 0;
  const delivered: { email: string; code: string }[] = [];
  const provider: StreamingProvider = {
    name: "openai",
    model: "synthetic/registration-bound-consent",
    async *stream() {
      calls++;
      yield {
        type: "delta",
        text: "Первый ответ без дополнительного подтверждения.",
      };
      yield { type: "complete", model: "synthetic/registration-bound-consent" };
    },
  };
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: provider.model,
    EMAIL_REGISTRATION_MODE: emailRequired ? "required" : "disabled",
    EMAIL_REGISTRATION_SECRET: "a".repeat(64),
    YOOKASSA_MODE: "disabled",
    PHONE_VERIFICATION_MODE: "disabled",
  });
  await seedTestBudget(db, config, { openai: provider });
  const app = await buildApp({
    db,
    provider,
    config,
    testing: true,
    ...(emailRequired
      ? {
          emailRegistrationDelivery: async (input: {
            email: string;
            code: string;
          }) => {
            delivered.push(input);
          },
        }
      : {}),
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const call = (url: string, payload?: object, token?: string) =>
    app.inject({
      method: payload === undefined ? "GET" : "POST",
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const policy = async () => {
    const response = await call("/v1/auth/registration-policy");
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ consentPolicy: ServiceConsentPolicy }>()
      .consentPolicy;
  };
  const choice = (current: ServiceConsentPolicy) => ({
    policyVersion: current.version,
    personalData: true,
    marketing: false,
  });
  const register = async () => {
    const current = await policy();
    const response = await call("/v1/auth/register", {
      email: randomUUID() + "@example.test",
      password: "123456",
      consents: choice(current),
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      current,
      ...response.json<{ token: string; user: { id: string } }>(),
    };
  };
  const send = async (token: string, text = "Мой первый вопрос") => {
    const boardResponse = await call("/v1/dashboard", undefined, token);
    assert.equal(boardResponse.statusCode, 200, boardResponse.body);
    const board = boardResponse.json<Dashboard>();
    const started = await call("/v1/conversations/start", {}, token);
    assert.equal(started.statusCode, 200, started.body);
    return call(
      `/v1/threads/${started.json<{ id: string }>().id}/messages`,
      {
        requestId: randomUUID(),
        text,
        policyId: board.aiAccess.policy!.id,
      },
      token,
    );
  };
  const disable = () =>
    db.query(
      "update ai_routing set provider='disabled',policy_id=null,revision=revision+1 where id=1",
    );
  return {
    db,
    app,
    call,
    policy,
    choice,
    register,
    send,
    disable,
    delivered,
    calls: () => calls,
  };
}

test("registration's explicit checkbox binds the displayed AI snapshot and permits the first answer without a separate grant", async (t) => {
  const f = await fixture(t);
  const { current, token, user } = await f.register();
  assert.match(current.version, /^v2-ai-[a-f0-9]{64}$/);
  assert.equal(
    current.aiProcessing?.model,
    "synthetic/registration-bound-consent",
  );
  assert.ok(current.personalData.text.includes(current.aiProcessing!.data));
  assert.deepEqual((await f.call("/v1/legal/consent-policy")).json(), current);
  const board = (
    await f.call("/v1/dashboard", undefined, token)
  ).json<Dashboard>();
  assert.equal(board.user.serviceConsentRequired, false);
  assert.equal(board.aiAccess.granted, true);
  assert.equal(f.calls(), 0);
  const evidence = (
    await f.db.query<{
      policy_snapshot: ServiceConsentPolicy;
      policy_hash: string;
      decision: string;
    }>(
      "select policy_snapshot,policy_hash,decision from service_consent_events where user_id=$1 and purpose='personal-data'",
      [user.id],
    )
  ).rows;
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0]!.policy_snapshot, current);
  assert.equal(evidence[0]!.policy_hash, consentPolicyHash(current));
  const ai = (
    await f.db.query<{ details: unknown; action: string }>(
      "select details,action from consent_events where user_id=$1 and consent_key='ai-recipient'",
      [user.id],
    )
  ).rows;
  assert.deepEqual(ai, [{ details: current.aiProcessing, action: "granted" }]);
  const reply = await f.send(token);
  assert.equal(reply.statusCode, 200, reply.body);
  assert.match(reply.body, /Первый ответ без дополнительного подтверждения/);
  assert.equal(f.calls(), 1);
  assert.equal(
    (await f.call("/v1/account/consents", undefined, token)).json()
      .marketingGranted,
    false,
  );
});

test("stale registration policy is rejected before account/session/AI evidence writes", async (t) => {
  const f = await fixture(t);
  const old = await f.policy();
  await f.disable();
  const response = await f.call("/v1/auth/register", {
    email: "changed@example.test",
    password: "123456",
    consents: f.choice(old),
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, "SERVICE_CONSENT_POLICY_CHANGED");
  for (const table of [
    "users",
    "sessions",
    "ai_consents",
    "consent_events",
    "service_consent_events",
  ])
    assert.equal(
      (await f.db.query(`select 1 from ${table}`)).rows.length,
      0,
      table,
    );
  assert.equal(f.calls(), 0);
});

test("email confirmation creates the account and exact AI grant together; OTP replay cannot append another grant", async (t) => {
  const f = await fixture(t, true);
  const current = await f.policy();
  const begin = await f.call("/v1/auth/email/register", {
    email: "otp@example.test",
    password: "123456",
    consents: f.choice(current),
  });
  assert.equal(begin.statusCode, 200, begin.body);
  assert.equal(f.delivered.length, 1);
  assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
  const input = {
    ...begin.json<{ challengeId: string; proof: string }>(),
    code: f.delivered[0]!.code,
  };
  // Only the fields admitted by the endpoint form part of the OTP operation.
  const proof = {
    challengeId: input.challengeId,
    proof: input.proof,
    code: input.code,
  };
  const confirmed = await f.call("/v1/auth/email/confirm", proof);
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const token = confirmed.json<{ token: string }>().token;
  const board = (
    await f.call("/v1/dashboard", undefined, token)
  ).json<Dashboard>();
  assert.equal(board.aiAccess.granted, true);
  assert.equal(board.user.serviceConsentRequired, false);
  assert.equal((await f.call("/v1/auth/email/confirm", proof)).statusCode, 400);
  assert.equal(
    (
      await f.db.query(
        "select 1 from consent_events where consent_key='ai-recipient'",
      )
    ).rows.length,
    1,
  );
  assert.equal(f.calls(), 0);
});

test("a recipient change during email verification cannot grant the replacement recipient or create the account", async (t) => {
  const f = await fixture(t, true);
  const old = await f.policy();
  const begin = await f.call("/v1/auth/email/register", {
    email: "changed-otp@example.test",
    password: "123456",
    consents: f.choice(old),
  });
  assert.equal(begin.statusCode, 200, begin.body);
  const pending = begin.json<{ challengeId: string; proof: string }>();
  await f.disable();
  const confirmed = await f.call("/v1/auth/email/confirm", {
    challengeId: pending.challengeId,
    proof: pending.proof,
    code: f.delivered[0]!.code,
  });
  assert.equal(confirmed.statusCode, 409, confirmed.body);
  assert.equal(confirmed.json().code, "SERVICE_CONSENT_POLICY_CHANGED");
  assert.equal((await f.db.query("select 1 from users")).rows.length, 0);
  assert.equal((await f.db.query("select 1 from ai_consents")).rows.length, 0);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.calls(), 0);
});

test("legacy v1 acceptance is not converted; one explicit current choice unlocks chat but never sends a question", async (t) => {
  const f = await fixture(t),
    repo = new Repository(f.db);
  const id = await repo.register(
    "old@example.test",
    await hashPassword("123456"),
  );
  await repo.createSession(id, tokenHash("legacy-session"));
  const old = { ...serviceConsentPolicy, version: "2026-10-25-v1" };
  await f.db.query(
    "insert into service_consent_events(user_id,subject_email,policy_version,policy_snapshot,policy_hash,purpose,decision,source) values($1,'old@example.test',$2,$3::jsonb,$4,'personal-data','granted','signup')",
    [id, old.version, JSON.stringify(old), consentPolicyHash(old)],
  );
  const board = (
    await f.call("/v1/dashboard", undefined, "legacy-session")
  ).json<Dashboard>();
  assert.equal(board.user.serviceConsentRequired, true);
  assert.equal(board.thread, null);
  const denied = await f.call("/v1/conversations/start", {}, "legacy-session");
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().code, "SERVICE_CONSENT_REQUIRED");
  assert.equal((await f.db.query("select 1 from ai_consents")).rows.length, 0);
  const current = await f.policy();
  const accepted = await f.call(
    "/v1/account/consents",
    f.choice(current),
    "legacy-session",
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().serviceConsentRequired, false);
  assert.equal(f.calls(), 0);
  assert.equal((await f.db.query("select 1 from messages")).rows.length, 0);
  const oldEvidence = (
    await f.db.query<{ policy_snapshot: unknown }>(
      "select policy_snapshot from service_consent_events where policy_version=$1",
      [old.version],
    )
  ).rows;
  assert.deepEqual(oldEvidence, [{ policy_snapshot: old }]);
});

test("revocation remains effective until another explicit current choice and does not silently restore on dashboard", async (t) => {
  const f = await fixture(t);
  const { token, user, current } = await f.register();
  await new Repository(f.db).aiConsent(user.id, null);
  for (let read = 0; read < 2; read++) {
    const board = (
      await f.call("/v1/dashboard", undefined, token)
    ).json<Dashboard>();
    assert.equal(board.user.serviceConsentRequired, true);
    assert.equal(board.aiAccess.granted, false);
  }
  assert.equal(
    (await f.call("/v1/conversations/start", {}, token)).statusCode,
    403,
  );
  const accepted = await f.call(
    "/v1/account/consents",
    f.choice(current),
    token,
  );
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().serviceConsentRequired, false);
  assert.equal(f.calls(), 0);
});

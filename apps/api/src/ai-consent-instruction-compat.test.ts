import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  buildServiceConsentPolicy,
  connectDatabase,
  consentPolicyHash,
  migrate,
  Repository,
  ServiceConsents,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { CONTRACT_VERSION_HEADER, type Dashboard } from "@citygo/contracts";
import type { StreamingProvider } from "@citygo/llm";
import { buildApp } from "./app.js";
import { createAssistantModes } from "./ai-modes.js";
import { hashPassword, tokenHash } from "./auth.js";

const settings = {
  NODE_ENV: "test",
  DATABASE_URL: "pglite://:memory:",
  LLM_PROVIDER: "routerai",
  AI_ASSISTANT_MODES: "enabled",
  AI_CREDIT_MODE: "routerai_citygo_10x",
  AI_CREDIT_RESERVATION_MODE: "fixed5_overdraft",
  AI_CUSTOMER_BILLING_MODE: "postpay_actual_v1",
  AI_MODES_DATA_NOTICE:
    "Synthetic mode recipients, not an approved production notice.",
  AI_MINIMUM_FIXED_FEE: "enabled",
  GIGACHAT_MODEL: "GigaChat-3-Ultra",
  GIGACHAT_SCOPE: "GIGACHAT_API_PERS",
  GIGACHAT_CREDENTIALS: Buffer.from(
    "synthetic-client:synthetic-secret",
  ).toString("base64"),
  ROUTERAI_MAX_OUTPUT_TOKENS: "4096",
  AI_MAXIMUM_WEB_SEARCH: "routerai_native_postpay_v1",
  AI_CONTEXT_STRATEGY: "model_window_memory_v1",
  LLM_MAX_INPUT_BYTES: "8388608",
  YOOKASSA_MODE: "disabled",
  PHONE_VERIFICATION_MODE: "disabled",
};

async function fixture(t: TestContext) {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected network transport in consent access regression");
  });
  const db = await connectDatabase("pglite://:memory:");
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      await db.close();
    }
  });
  await migrate(db);
  let modelCalls = 0;
  const adapter = (
    name: "routerai" | "gigachat",
    model: string,
  ): StreamingProvider => ({
    name,
    model,
    async *stream() {
      modelCalls++;
      yield { type: "delta", text: "Unexpected synthetic generation" };
      throw Error("Access checks must never generate an answer");
    },
    async readCharge() {
      modelCalls++;
      throw Error("Access checks must never read a provider receipt");
    },
  });
  const modeProviders = {
    maximum: adapter("routerai", "openai/gpt-6.1-sol"),
    balanced: adapter("routerai", "deepseek/deepseek-v4-pro-0813"),
    minimum: adapter("gigachat", "GigaChat-3-Ultra"),
  };
  const originalConfig = readConfig(settings);
  const originalModes = createAssistantModes(originalConfig, modeProviders)!;
  const previousPolicy = structuredClone(originalModes.policy);
  const previousService = buildServiceConsentPolicy(previousPolicy);
  // Recorded from the pinned native-v1 factory at 288cf966 with the exact
  // synthetic notice/settings above; no old-ID calculation uses the new helper.
  assert.equal(
    previousPolicy.id,
    "8e14be614e3d541908b1e57748de1410ce703f31f9849f1a4691701f61b82d82",
  );
  assert.equal(
    previousService.version,
    "v2-ai-f04607edcdaf46812d0bfc8360393892fe6a21b380ff8503d60c08dea5f90897",
  );
  assert.equal(
    consentPolicyHash(previousService),
    "f910bb28b52c2302fe48fd70333b7f9e8175874a6acb480c299a6c2fcf4a648c",
  );
  assert.notEqual(
    originalModes.routes[0]!.execution.key,
    "6b9e4bd2933c0cad5750a7d809293ac52f1f2188ed99016484e52ffdd664fdde",
    "the new instruction execution is distinct from native-v1 consent identity",
  );
  await new Repository(db).initializeAiRouting(previousPolicy);
  const oldConsents = new ServiceConsents(db, () => previousPolicy);
  const token = randomUUID();
  const user = await oldConsents.register(
    "native-v1-" + randomUUID() + "@example.test",
    await hashPassword("synthetic-password"),
    tokenHash(token),
    {
      policyVersion: previousService.version,
      personalData: true,
      marketing: false,
    },
  );
  const evidence = async () => ({
    service: (
      await db.query(
        "select * from service_consent_events where user_id=$1 order by id",
        [user.id],
      )
    ).rows,
    choices: (
      await db.query(
        "select * from consent_events where user_id=$1 order by id",
        [user.id],
      )
    ).rows,
    grants: (
      await db.query("select * from ai_consents where user_id=$1", [user.id])
    ).rows,
  });
  const openApp = async (overrides: NodeJS.ProcessEnv = {}) => {
    await app?.close();
    app = undefined;
    const config = readConfig({ ...settings, ...overrides });
    const modes = createAssistantModes(config, modeProviders)!;
    await db.query(
      "update ai_routing set provider='routerai',policy_id=$1,revision=revision+1 where id=1",
      [modes.policy.id],
    );
    await db.query(
      "update ai_budget set enabled=true,currency='RUB',daily_limit_micros=100000000,total_limit_micros=100000000,rules=$1 where id=1",
      [
        JSON.stringify(
          modes.routes
            .filter((route) => route.providerName === "routerai")
            .map((route) => ({
              ...route.execution,
              attemptCeilingMicros: 1000000,
            })),
        ),
      ],
    );
    app = await buildApp({
      db,
      config,
      testing: true,
      modeProviders,
    });
    return modes;
  };
  const call = (url: string, payload?: object) => {
    assert(app);
    return app.inject({
      method: payload === undefined ? "GET" : "POST",
      url,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        "x-citygo-client": "native",
        authorization: "Bearer " + token,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  };
  const assertNoProviderCalls = () => {
    assert.equal(modelCalls, 0);
    assert.equal(fetch.mock.callCount(), 0);
  };
  return {
    db,
    user,
    previousPolicy,
    previousService,
    evidence,
    openApp,
    call,
    assertNoProviderCalls,
  };
}

test("an existing native-v1 grant admits protected HTTP access with v2 instructions without rewriting consent evidence", async (t) => {
  const f = await fixture(t);
  const before = await f.evidence();
  const modes = await f.openApp();
  assert.equal(modes.policy.id, f.previousPolicy.id);
  for (let read = 0; read < 2; read++) {
    const response = await f.call("/v1/dashboard");
    assert.equal(response.statusCode, 200, response.body);
    const board = response.json<Dashboard>();
    assert.equal(board.user.serviceConsentRequired, false);
    assert.equal(board.aiAccess.granted, true);
    assert.deepEqual(
      board.aiAccess.modes?.options.map(({ id, available }) => ({
        id,
        available,
      })),
      [
        { id: "maximum", available: true },
        { id: "balanced", available: true },
        { id: "minimum", available: true },
      ],
    );
  }
  const started = await f.call("/v1/conversations/start", {});
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(
    (await f.call("/v1/account/consents")).json().serviceConsentRequired,
    false,
  );
  assert.deepEqual(await f.evidence(), before);
  f.assertNoProviderCalls();
});

test("a genuinely changed native notice or processing scope still blocks protected access without upgrading the old grant", async (t) => {
  const f = await fixture(t);
  const before = await f.evidence();
  for (const change of [
    {
      AI_MODES_DATA_NOTICE:
        "Changed recipients, data scope and storage conditions.",
    },
    { AI_MAXIMUM_WEB_SEARCH: "disabled" },
  ]) {
    const modes = await f.openApp(change);
    assert.notEqual(modes.policy.id, f.previousPolicy.id);
    const response = await f.call("/v1/dashboard");
    assert.equal(response.statusCode, 200, response.body);
    const board = response.json<Dashboard>();
    assert.equal(board.user.serviceConsentRequired, true);
    assert.equal(board.aiAccess.granted, false);
    const denied = await f.call("/v1/conversations/start", {});
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().code, "SERVICE_CONSENT_REQUIRED");
    assert.deepEqual(await f.evidence(), before);
  }
  f.assertNoProviderCalls();
});

test("a later real withdrawal remains effective with compatible instructions and access checks cannot restore it", async (t) => {
  const f = await fixture(t);
  await f.openApp();
  const revoked = await f.call("/v1/ai/consent", { action: "revoked" });
  assert.equal(revoked.statusCode, 200, revoked.body);
  const withdrawn = await f.evidence();
  assert.equal(withdrawn.choices.at(-1)!.action, "revoked");
  assert.equal(withdrawn.grants[0]!.granted, false);
  for (let read = 0; read < 2; read++) {
    const response = await f.call("/v1/dashboard");
    assert.equal(response.statusCode, 200, response.body);
    const board = response.json<Dashboard>();
    assert.equal(board.user.serviceConsentRequired, true);
    assert.equal(board.aiAccess.granted, false);
  }
  const denied = await f.call("/v1/conversations/start", {});
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().code, "SERVICE_CONSENT_REQUIRED");
  assert.deepEqual(await f.evidence(), withdrawn);
  f.assertNoProviderCalls();
});

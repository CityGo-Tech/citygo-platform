import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { readConfig } from "@citygo/config";
import {
  connectDatabase,
  migrate,
  parseLegacyBalancedConsentCompatibility,
  ServiceConsents,
} from "@citygo/db";
import { buildApp } from "./app.js";
import { createAssistantModes } from "./ai-modes.js";
import { createAiExecution } from "./ai-execution.js";
import { createAiPolicy } from "./ai-policy.js";
import { createProviderRegistry } from "./provider.js";

type Billing = "legacy" | "postpay_actual_v1";
async function productionConfig(billing: Billing, balanceLimit = false) {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../deploy/fixtures/routerai-citygo-10x-yookassa-live-cn-fiscal-overdraft-postbox-email-prostosms-unlimited-assistant-modes-gigachat-flat3-profile.fixture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as NodeJS.ProcessEnv;
  const settings = {
    ...fixture,
    NODE_ENV: "production",
    LLM_PROVIDER: "routerai",
    WEB_ORIGIN: "https://pilot.example.test",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    AI_CUSTOMER_BILLING_MODE: billing,
    AI_REQUEST_COST_LIMIT_MODE: balanceLimit
      ? "user_balance"
      : "operator_ceiling",
    // The SAME public CA bytes are read at their source-checkout path here.
    GIGACHAT_CA_BUNDLE_FILE: fileURLToPath(
      new URL(
        "../../../deploy/certificates/russian-trusted-root.crt",
        import.meta.url,
      ),
    ),
  };
  const preview = readConfig(settings);
  const policy = createAiPolicy(preview, {
    name: "routerai",
    model: preview.ROUTERAI_MODEL!,
  });
  const modes = createAssistantModes(preview);
  assert.ok(policy && modes);
  return readConfig({
    ...settings,
    ROUTERAI_PRODUCTION_POLICY_ID: policy.id,
    AI_MODES_PRODUCTION_POLICY_ID: modes.policy.id,
  });
}

async function startup(t: TestContext, billing: Billing, balanceLimit = false) {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(
      "Provider fetch forbidden in production-startup regression",
    );
  });
  const request = t.mock.method(https, "request", () => {
    throw new Error(
      "Provider HTTPS forbidden in production-startup regression",
    );
  });
  const config = await productionConfig(billing, balanceLimit);
  assert.equal(config.NODE_ENV, "production");
  assert.equal(config.LLM_MAX_INPUT_BYTES, 8192);
  assert.equal(config.ROUTERAI_MAX_OUTPUT_TOKENS, 4096);
  const modes = createAssistantModes(config)!;
  assert.equal(modes.productionApproved, true);
  assert.ok(modes.routes.every((route) => route.provider));
  const db = await connectDatabase("pglite://:memory:");
  const cleanup: { app?: Awaited<ReturnType<typeof buildApp>> } = {};
  t.after(async () => {
    await cleanup.app?.close();
    await db.close();
    assert.equal(fetch.mock.callCount(), 0);
    assert.equal(request.mock.callCount(), 0);
  });
  await migrate(db);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'disabled',null,1)",
  );
  // This is the real production caller contract: no injected mode/provider mock.
  // Only the disposable DB and logger are supplied by the test harness.
  const app = await buildApp({
    db,
    config,
    ...createProviderRegistry(config),
    testing: true,
  });
  cleanup.app = app;
  assert.equal(
    (await app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/dashboard" })).statusCode,
    401,
  );
  assert.deepEqual(
    (await db.query("select provider,policy_id from ai_routing where id=1"))
      .rows,
    [{ provider: "disabled", policy_id: null }],
  );
  assert.equal(
    (await db.query("select enabled from ai_budget where id=1")).rows[0]
      ?.enabled,
    false,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from ai_postpay_attempts"))
      .rows[0]?.n,
    0,
  );
  return { config, modes, db };
}

test("production postpay boots with exact retained limits, preserves current grants and requires explicit confirmation for a pre-mode grant", async (t) => {
  const f = await startup(t, "postpay_actual_v1");
  assert.equal(f.modes.legacyBalancedCompatibility, undefined);
  const routing = {
    provider: "routerai" as const,
    policyId: f.modes.policy.id,
    revision: 2,
  };
  await f.db.query(
    "update ai_routing set provider='routerai',policy_id=$1,revision=2 where id=1",
    [routing.policyId],
  );
  const current = new ServiceConsents(f.db, () => f.modes.policy);
  const currentPolicy = await current.policy();
  const register = async (store: ServiceConsents, version: string) =>
    store.register(
      randomUUID() + "@example.test",
      "synthetic-hash",
      randomUUID(),
      { policyVersion: version, personalData: true, marketing: false },
    );
  const currentUser = await register(current, currentPolicy.version);
  const granted = await current.state(currentUser.id);
  assert.equal(granted.currentAiConsentRequired, false);
  assert.equal(
    f.modes.resolve(routing, { aiMode: "balanced" }, granted).execution.key,
    f.modes.routes.find((route) => route.id === "balanced")!.execution.key,
  );

  const oldModes = createAssistantModes(await productionConfig("legacy"))!;
  const old = oldModes.legacyBalancedCompatibility!;
  assert.ok(old);
  await f.db.query(
    "update ai_routing set policy_id=$1,revision=revision+1 where id=1",
    [old.policy.id],
  );
  const prior = new ServiceConsents(f.db, () => old.policy);
  const priorPolicy = await prior.policy();
  const oldUser = await register(prior, priorPolicy.version);
  await f.db.query(
    "update ai_routing set policy_id=$1,revision=revision+1 where id=1",
    [routing.policyId],
  );
  const before = await f.db.query(
    "select * from consent_events where user_id=$1 order by id",
    [oldUser.id],
  );
  const missing = await current.state(oldUser.id);
  assert.equal(missing.currentAiConsentRequired, true);
  assert.throws(
    () => f.modes.resolve(routing, { aiMode: "balanced" }, missing),
    { code: "AI_MODE_UNAVAILABLE", statusCode: 503 },
  );
  assert.deepEqual(
    await f.db.query(
      "select * from consent_events where user_id=$1 order by id",
      [oldUser.id],
    ),
    before,
  );
  const accepted = await current.acceptAiModes(oldUser.id, {
    expectedUserId: oldUser.id,
    policyId: f.modes.policy.id,
    policyVersion: currentPolicy.version,
    personalData: true,
  });
  assert.equal(accepted.currentAiConsentRequired, false);
  assert.equal(accepted.marketingGranted, false);
  assert.equal(
    f.modes.resolve(routing, { aiMode: "balanced" }, accepted).execution.key,
    f.modes.routes.find((route) => route.id === "balanced")!.execution.key,
  );
});

test("production legacy profile retains its exact historical compatibility; new billing and admission keys cannot impersonate it", async (t) => {
  const f = await startup(t, "legacy");
  const compatibility = f.modes.legacyBalancedCompatibility;
  assert.ok(compatibility);
  assert.deepEqual(
    parseLegacyBalancedConsentCompatibility(compatibility),
    compatibility,
  );
  assert.equal(
    compatibility.execution.key,
    createHash("sha256")
      .update(
        JSON.stringify({
          version: "ai-reserve-v1",
          policyId: compatibility.policy.id,
          maxInputBytes: 8192,
          maxOutputTokens: 4096,
          creditReservationMode: "fixed5_overdraft",
        }),
      )
      .digest("hex"),
  );
  for (const config of [
    await productionConfig("postpay_actual_v1"),
    await productionConfig("legacy", true),
  ]) {
    const value = createAssistantModes(config)!;
    assert.equal(value.legacyBalancedCompatibility, undefined);
    const changed = {
      ...compatibility,
      execution: createAiExecution(config, compatibility.policy),
    };
    assert.notEqual(changed.execution.key, compatibility.execution.key);
    assert.throws(() => parseLegacyBalancedConsentCompatibility(changed), {
      statusCode: 503,
    });
  }
});

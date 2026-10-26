import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AiPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  ServiceConsents,
  buildServiceConsentPolicy,
} from "./index.js";
import {
  parseLegacyBalancedConsentCompatibility,
  legacyBalancedGrant,
} from "./ai-consent-compatibility.js";
import {
  buildServiceConsentPolicy as purePolicy,
  consentPolicyHash,
} from "./service-consent-policy.js";
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fields = {
  version: "ai-recipient-v2",
  provider: "routerai" as const,
  model: "deepseek/deepseek-v4-pro-0813",
  recipient: "RouterAI",
  routing:
    "Дополнительный получатель (upstream): deepseek. Фильтр страны: cn. Фильтр не гарантирует место хранения данных.",
  data: "Exact synthetic legacy context, never a new model's notice.",
};
const policy: AiPolicy = { id: hash(fields), ...fields };
const compatibility = {
  routingPolicyId: hash("current-bundle"),
  policy,
  execution: {
    key: hash({
      version: "ai-reserve-v1",
      policyId: policy.id,
      maxInputBytes: 8192,
      maxOutputTokens: 4096,
      creditReservationMode: "fixed5_overdraft",
    }),
    policy,
    maxInputBytes: 8192,
    maxOutputTokens: 4096,
  },
};
test("pure policy extraction preserves exact existing version/hash", () => {
  assert.deepEqual(purePolicy(policy), buildServiceConsentPolicy(policy));
  assert.equal(
    consentPolicyHash(purePolicy(policy)),
    consentPolicyHash(buildServiceConsentPolicy(policy)),
  );
});
test("compatibility admits only exact unchanged DeepSeek policy/execution, not a new route or overrides", () => {
  assert.deepEqual(
    parseLegacyBalancedConsentCompatibility(compatibility),
    compatibility,
  );
  for (const mutate of [
    (v: typeof compatibility) => (v.policy.model = "openai/gpt-6.1-sol"),
    (v: typeof compatibility) => (v.policy.version = "ai-mode-route-v1"),
    (v: typeof compatibility) => v.execution.maxInputBytes++,
    (v: typeof compatibility) => (v.execution.key = "a".repeat(64)),
    (v: typeof compatibility) => (v.policy.data += " changed"),
    (v: typeof compatibility) =>
      ((v.execution as unknown as Record<string, unknown>).url =
        "https://unreviewed.test"),
  ]) {
    const v = structuredClone(compatibility);
    mutate(v);
    assert.throws(() => parseLegacyBalancedConsentCompatibility(v));
  }
});
test("legacy read requires actual matching personal-data AND AI evidence; never creates current consent or survives revocation", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1)",
    [policy.id],
  );
  const store = new ServiceConsents(db, () => policy);
  const p = await store.policy();
  const user = await store.register(
    "legacy@example.test",
    "synthetic-hash",
    "session-hash",
    { policyVersion: p.version, personalData: true, marketing: true },
  );
  const before = await db.query("select * from consent_events order by id");
  const grant = await legacyBalancedGrant(
    db,
    user.id,
    compatibility,
    compatibility.routingPolicyId,
  );
  assert.equal(grant?.policyId, policy.id);
  assert.ok(grant?.serviceEventId);
  assert.equal(
    await legacyBalancedGrant(
      db,
      user.id,
      compatibility,
      hash("other-routing"),
    ),
    undefined,
  );
  assert.deepEqual(
    await db.query("select * from consent_events order by id"),
    before,
  );
  await db.query(
    "insert into consent_events(user_id,consent_key,action,policy_version,details) values($1,'ai-recipient','revoked','all-recipients','{}')",
    [user.id],
  );
  assert.equal(
    await legacyBalancedGrant(
      db,
      user.id,
      compatibility,
      compatibility.routingPolicyId,
    ),
    undefined,
  );
  assert.equal(
    (
      await db.query("select policy_id from ai_consents where user_id=$1", [
        user.id,
      ])
    ).rows[0]?.policy_id,
    policy.id,
  );
});

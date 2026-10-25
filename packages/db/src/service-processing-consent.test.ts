import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { serviceConsentPolicy, type AiPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  EmailRegistration,
  buildServiceConsentPolicy,
  type ServiceAiPolicyResolver,
} from "./index.js";
import { consentPolicyHash } from "./service-consent-context.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const a: AiPolicy = {
  id: hash("synthetic-policy-a"),
  version: "synthetic-v1",
  provider: "routerai",
  model: "synthetic/model",
  recipient: "Synthetic AI recipient",
  routing: "Synthetic exact routing notice",
  data: "Synthetic exact context notice",
};
const b: AiPolicy = {
  ...a,
  id: hash("synthetic-policy-b"),
  data: "Changed synthetic context",
};
const resolve: ServiceAiPolicyResolver = (routing) =>
  [a, b].find((p) => p.id === routing.policyId) ?? null;
const choice = (policyVersion: string) => ({
  policyVersion,
  personalData: true as const,
  marketing: false,
});
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1)",
    [a.id],
  );
  return {
    db,
    store: new ServiceConsents(db, resolve),
    email: new EmailRegistration(db, undefined, resolve),
  };
}
async function empty(
  db: Awaited<ReturnType<typeof fixture>>["db"],
  tables: string[],
) {
  for (const table of tables)
    assert.deepEqual(
      (await db.query("select * from " + table)).rows,
      [],
      table,
    );
}
function registration(policyVersion: string) {
  return {
    id: randomUUID(),
    email: "synthetic-registered@example.test",
    passwordHash: "synthetic-hash",
    proofHash: hash("proof"),
    codeHash: hash("code"),
    recipientKey: hash("recipient"),
    ipKey: hash("ip"),
    consents: choice(policyVersion),
  };
}

test("effective version binds all exact AI disclosure fields and survives JSONB key order without mutating the base", () => {
  const original = JSON.stringify(serviceConsentPolicy);
  const policy = buildServiceConsentPolicy(a);
  assert.match(policy.version, /^v2-ai-[a-f0-9]{64}$/);
  assert.deepEqual(policy.aiProcessing, a);
  assert.ok(policy.personalData.text.includes(a.routing));
  assert.ok(policy.personalData.text.includes(a.data));
  assert.notEqual(
    policy.version,
    buildServiceConsentPolicy({ ...a, data: "Other details with same AI id" })
      .version,
  );
  assert.notEqual(policy.version, buildServiceConsentPolicy(b).version);
  const reordered = Object.fromEntries(
    Object.entries(policy).reverse(),
  ) as typeof policy;
  assert.equal(consentPolicyHash(policy), consentPolicyHash(reordered));
  assert.equal(JSON.stringify(serviceConsentPolicy), original);
  assert.equal(buildServiceConsentPolicy(null), serviceConsentPolicy);
});

test("one explicit registration choice commits exact service and AI evidence, never SMS or money; reads cannot restore a revoked grant", async (t) => {
  const { db, store } = await fixture(t);
  const policy = await store.policy();
  const user = await store.register(
    "synthetic@example.test",
    "synthetic-hash",
    hash("session"),
    choice(policy.version),
  );
  const evidence = (
    await db.query<{ policy_snapshot: unknown; policy_hash: string }>(
      "select policy_snapshot,policy_hash from service_consent_events order by id",
    )
  ).rows;
  assert.equal(evidence.length, 2);
  for (const row of evidence) {
    assert.deepEqual(row.policy_snapshot, policy);
    assert.equal(row.policy_hash, consentPolicyHash(policy));
  }
  assert.deepEqual(
    (await db.query("select policy_id,granted from ai_consents")).rows,
    [{ policy_id: a.id, granted: true }],
  );
  assert.deepEqual(
    (
      await db.query(
        "select details from consent_events where consent_key='ai-recipient'",
      )
    ).rows,
    [{ details: a }],
  );
  await empty(db, ["phone_welcome_claims", "ai_credit_entries"]);
  assert.equal((await store.state(user.id)).serviceConsentRequired, false);
  await store.choose(user.id, choice(policy.version));
  assert.equal(
    (
      await db.query(
        "select * from consent_events where consent_key='ai-recipient'",
      )
    ).rows.length,
    1,
  );
  await new Repository(db).aiConsent(user.id, null);
  assert.equal((await store.state(user.id)).serviceConsentRequired, true);
  assert.equal((await store.state(user.id)).personalDataGranted, true);
  assert.deepEqual((await db.query("select granted from ai_consents")).rows, [
    { granted: false },
  ]);
  await store.choose(user.id, choice(policy.version));
  assert.equal((await store.state(user.id)).serviceConsentRequired, false);
  assert.equal(
    (
      await db.query(
        "select * from consent_events where consent_key='ai-recipient' and action='granted'",
      )
    ).rows.length,
    2,
  );
});

test("legacy v1 and base-only checkbox are never converted to a runtime AI grant", async (t) => {
  const { db, store } = await fixture(t);
  const userId = await new Repository(db).register(
    "legacy@example.test",
    "synthetic-hash",
  );
  const legacy = {
    ...serviceConsentPolicy,
    version: "2026-10-25-v1",
    personalData: {
      ...serviceConsentPolicy.personalData,
      text: "Legacy consent explicitly excludes external AI processing",
    },
  };
  await db.query(
    "insert into service_consent_events(user_id,subject_email,policy_version,policy_snapshot,policy_hash,purpose,decision,source) values($1,'legacy@example.test',$2,$3::jsonb,$4,'personal-data','granted','existing-account')",
    [userId, legacy.version, JSON.stringify(legacy), consentPolicyHash(legacy)],
  );
  assert.equal((await store.state(userId)).serviceConsentRequired, true);
  await empty(db, ["ai_consents", "consent_events"]);
  for (const version of [legacy.version, serviceConsentPolicy.version])
    await assert.rejects(
      store.choose(userId, choice(version)),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SERVICE_CONSENT_POLICY_CHANGED",
    );
  const policy = await store.policy();
  await store.choose(userId, choice(policy.version));
  assert.equal((await store.state(userId)).serviceConsentRequired, false);
  assert.equal(
    (
      await db.query(
        "select * from service_consent_events where policy_version=$1",
        [legacy.version],
      )
    ).rows.length,
    1,
  );
});

test("unavailable AI grants nothing for the future and a resolver cannot substitute an undisclosed routing identity", async (t) => {
  const { db, store } = await fixture(t);
  const unavailable = new ServiceConsents(db, () => null);
  const user = await unavailable.register(
    "without-ai@example.test",
    "synthetic-hash",
    hash("session"),
    choice((await unavailable.policy()).version),
  );
  assert.equal(
    (await unavailable.state(user.id)).serviceConsentRequired,
    false,
  );
  await empty(db, ["ai_consents", "consent_events"]);
  assert.equal((await store.state(user.id)).serviceConsentRequired, true);
  const inconsistent = new ServiceConsents(db, () => b);
  await assert.rejects(
    inconsistent.policy(),
    /Условия обработки сообщений изменились/,
  );
  await assert.rejects(
    new ServiceConsents(db, (routing) => {
      routing.policyId = b.id;
      return b;
    }).policy(),
    /Условия обработки сообщений изменились/,
  );
  await db.query(
    "update ai_routing set provider='disabled',policy_id=null,revision=revision+1 where id=1",
  );
  await assert.rejects(
    new ServiceConsents(db, () => a).policy(),
    /Условия обработки сообщений изменились/,
  );
  await empty(db, ["ai_consents", "consent_events"]);
});

test("email choice freezes exact recipient before delivery and a changed policy cannot resend, consume OTP, grant or create an account", async (t) => {
  const { db, store, email } = await fixture(t);
  const value = registration((await store.policy()).version);
  await email.begin(value);
  await email.markSent(value.id, value.codeHash);
  const before = (
    await db.query(
      "select consent_policy,consent_policy_hash,consent_recorded_at::text from email_registrations",
    )
  ).rows;
  assert.deepEqual(
    (before[0]!.consent_policy as { aiProcessing: unknown }).aiProcessing,
    a,
  );
  await empty(db, ["users", "ai_consents", "consent_events"]);
  await db.query(
    "update ai_routing set policy_id=$1,revision=revision+1 where id=1",
    [b.id],
  );
  for (const operation of [
    () =>
      email.resend({
        id: value.id,
        proofHash: value.proofHash,
        codeHash: hash("new-code"),
        ipKey: value.ipKey,
      }),
    () =>
      email.confirm({
        id: value.id,
        proofHash: value.proofHash,
        codeHash: value.codeHash,
        sessionHash: hash("session"),
      }),
  ])
    await assert.rejects(
      operation(),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SERVICE_CONSENT_POLICY_CHANGED",
    );
  await empty(db, [
    "users",
    "sessions",
    "ai_consents",
    "consent_events",
    "service_consent_events",
  ]);
  assert.deepEqual(
    (
      await db.query(
        "select consent_policy,consent_policy_hash,consent_recorded_at::text from email_registrations",
      )
    ).rows,
    before,
  );
  assert.deepEqual(
    (await db.query("select consumed_user_id from email_registrations")).rows,
    [{ consumed_user_id: null }],
  );
});

test("failure recording AI evidence rolls back signup and OTP consumption with service evidence; successful retry uses the original choice time", async (t) => {
  const { db, store, email } = await fixture(t);
  const value = registration((await store.policy()).version);
  await email.begin(value);
  await email.markSent(value.id, value.codeHash);
  const confirmation = {
    id: value.id,
    proofHash: value.proofHash,
    codeHash: value.codeHash,
    sessionHash: hash("session"),
  };
  await db.exec(
    "create function synthetic_fail_ai_evidence() returns trigger language plpgsql as $$ begin raise exception 'synthetic evidence failure'; end $$; create trigger synthetic_fail_ai_evidence before insert on consent_events for each row execute function synthetic_fail_ai_evidence()",
  );
  await assert.rejects(
    store.register(
      "failed@example.test",
      "synthetic-hash",
      hash("other-session"),
      value.consents,
    ),
    /synthetic evidence failure/,
  );
  await assert.rejects(
    email.confirm(confirmation),
    /synthetic evidence failure/,
  );
  await empty(db, [
    "users",
    "sessions",
    "ai_consents",
    "consent_events",
    "service_consent_events",
  ]);
  assert.deepEqual(
    (await db.query("select consumed_user_id from email_registrations")).rows,
    [{ consumed_user_id: null }],
  );
  await db.exec(
    "drop trigger synthetic_fail_ai_evidence on consent_events; drop function synthetic_fail_ai_evidence()",
  );
  const user = await email.confirm(confirmation);
  assert.equal((await store.state(user.id)).serviceConsentRequired, false);
  assert.deepEqual(
    (await db.query("select policy_id,granted from ai_consents")).rows,
    [{ policy_id: a.id, granted: true }],
  );
  assert.equal(
    (
      await db.query(
        "select * from service_consent_events e join email_registrations r on r.id=e.registration_id where e.choice_recorded_at=r.consent_recorded_at",
      )
    ).rows.length,
    2,
  );
  await assert.rejects(email.confirm(confirmation));
  assert.equal(
    (
      await db.query(
        "select * from consent_events where consent_key='ai-recipient'",
      )
    ).rows.length,
    1,
  );
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { AiPolicy } from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  Repository,
  ServiceConsents,
  buildServiceConsentPolicy,
} from "./index.js";
import {
  assertAiRequestModeAttempt,
  recordAiRequestMode,
} from "./ai-request-modes.js";
import {
  assertAiConsentBasisAttempt,
  legacyBalancedGrant,
  recordAiConsentBasis,
} from "./ai-consent-compatibility.js";
const h = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fields = {
  version: "ai-recipient-v2",
  provider: "routerai" as const,
  model: "deepseek/deepseek-v4-pro-0813",
  recipient: "RouterAI",
  routing:
    "Дополнительный получатель (upstream): deepseek. Фильтр страны: cn. Фильтр не гарантирует место хранения данных.",
  data: "Exact legacy synthetic data and operator notice.",
};
const policy: AiPolicy = { id: h(fields), ...fields };
const bundle: AiPolicy = {
  ...policy,
  id: h("current-bundle"),
  version: "ai-assistant-modes-v1",
  model: "citygo/assistant-modes-v1",
  recipient: "Current synthetic modes recipients",
};
const execution = {
  key: h({
    version: "ai-reserve-v1",
    policyId: policy.id,
    maxInputBytes: 8192,
    maxOutputTokens: 4096,
    creditReservationMode: "fixed5_overdraft",
  }),
  policy,
  maxInputBytes: 8192,
  maxOutputTokens: 4096,
};
const compatibility = { routingPolicyId: bundle.id, policy, execution };
async function fixture(t: TestContext) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  await db.query(
    "insert into ai_routing(id,provider,policy_id,revision) values(1,'routerai',$1,1)",
    [policy.id],
  );
  const resolve = (row: { policyId: string | null }) =>
    [policy, bundle].find((p) => p.id === row.policyId) ?? null;
  const old = new ServiceConsents(db, resolve),
    p = await old.policy();
  const user = await old.register(
    "legacy-mode@example.test",
    "synthetic-hash",
    "synthetic-session",
    { policyVersion: p.version, personalData: true, marketing: true },
  );
  await db.query("update ai_routing set policy_id=$1,revision=2 where id=1", [
    bundle.id,
  ]);
  const store = new ServiceConsents(db, resolve, compatibility),
    repo = new Repository(
      db,
      false,
      undefined,
      false,
      "fixed5_overdraft",
      false,
      compatibility,
    );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
      [user.id],
    )
  ).rows[0]!.id;
  const snapshot = {
    mode: "balanced" as const,
    catalogId: h("legacy-catalog"),
    policy,
    execution,
    upstream: "deepseek",
  };
  const access = {
    policyId: bundle.id,
    revision: 2,
    userDailyLimit: 100,
    globalDailyLimit: 100,
    modeSnapshot: snapshot,
  };
  const choice = {
    expectedUserId: user.id,
    policyId: bundle.id,
    policyVersion: buildServiceConsentPolicy(bundle).version,
    personalData: true,
  };
  return { db, store, repo, user, thread, snapshot, access, choice };
}
test("old real grant keeps only unchanged Balanced; real current choice is lazy/idempotent and preserves marketing", async (t) => {
  const f = await fixture(t);
  const before = await f.store.state(f.user.id);
  assert.equal(before.serviceConsentRequired, false);
  assert.equal(before.currentAiConsentRequired, true);
  assert.equal(before.marketingGranted, true);
  const marketing = (
    await f.db.query(
      "select * from service_consent_events where purpose='marketing'",
    )
  ).rows;
  const req = randomUUID();
  await f.repo.reserveChat(
    f.user.id,
    f.thread,
    req,
    "Synthetic legacy question",
    f.access,
  );
  const receipt = (await f.db.query("select * from ai_request_consent_bases"))
    .rows[0];
  assert.equal(receipt?.basis, "legacy-balanced");
  assert.equal(receipt?.grant_policy_id, policy.id);
  assert.equal(receipt?.routing_policy_id, bundle.id);
  const after = await f.store.acceptAiModes(f.user.id, f.choice);
  assert.equal(after.currentAiConsentRequired, false);
  assert.equal(after.marketingGranted, true);
  assert.deepEqual(
    (
      await f.db.query(
        "select * from service_consent_events where purpose='marketing'",
      )
    ).rows,
    marketing,
  );
  const count = (
    await f.db.query("select count(*)::int n from service_consent_events")
  ).rows[0];
  await f.store.acceptAiModes(f.user.id, f.choice);
  assert.deepEqual(
    (await f.db.query("select count(*)::int n from service_consent_events"))
      .rows[0],
    count,
  );
  // Already admitted legacy work keeps its real old basis after new acceptance.
  await assertAiRequestModeAttempt(f.db, {
    userId: f.user.id,
    threadId: f.thread,
    requestId: req,
    consentPolicyId: bundle.id,
    policyId: policy.id,
    routingRevision: 2,
    provider: "routerai",
    model: policy.model,
    execution,
    upstream: "deepseek",
    mode: { id: "balanced", catalogId: f.snapshot.catalogId },
  });
  await assertAiConsentBasisAttempt(
    f.db,
    {
      userId: f.user.id,
      threadId: f.thread,
      requestId: req,
      routingPolicyId: bundle.id,
      snapshot: f.snapshot,
    },
    compatibility,
  );
  await assert.rejects(
    assertAiConsentBasisAttempt(
      f.db,
      {
        userId: f.user.id,
        threadId: f.thread,
        requestId: randomUUID(),
        routingPolicyId: bundle.id,
        snapshot: f.snapshot,
      },
      compatibility,
    ),
  );
  assert.deepEqual(
    (await f.db.query("select * from ai_request_consent_bases")).rows[0],
    receipt,
  );
  await assert.rejects(
    f.db.query("update ai_request_consent_bases set grant_policy_id=$1", [
      bundle.id,
    ]),
  );
  await assert.rejects(f.db.query("delete from ai_request_consent_bases"));
});

test("every current mode requires real grant evidence and immutable receipt even without a legacy compatibility descriptor", async (t) => {
  const f = await fixture(t);
  await f.store.acceptAiModes(f.user.id, f.choice);
  await assert.rejects(
    f.repo.reserveChat(
      f.user.id,
      f.thread,
      randomUUID(),
      "Captured old catalog",
      f.access,
    ),
    (e: unknown) =>
      !!e &&
      typeof e === "object" &&
      "code" in e &&
      e.code === "AI_MODE_CHANGED",
  );
  const currentPolicy = {
    ...policy,
    id: h("current-mode-route"),
    version: "ai-mode-route-v1",
  };
  const currentSnapshot = {
    ...f.snapshot,
    catalogId: h("current-mode-catalog"),
    policy: currentPolicy,
    execution: {
      ...execution,
      key: h("current-mode-execution"),
      policy: currentPolicy,
    },
  };
  const repo = new Repository(f.db),
    requestId = randomUUID();
  await repo.reserveChat(f.user.id, f.thread, requestId, "Current question", {
    ...f.access,
    modeSnapshot: currentSnapshot,
  });
  assert.equal(
    (await f.db.query("select basis from ai_request_consent_bases")).rows[0]
      ?.basis,
    "current",
  );
  await assertAiConsentBasisAttempt(f.db, {
    userId: f.user.id,
    threadId: f.thread,
    requestId,
    routingPolicyId: bundle.id,
    snapshot: currentSnapshot,
  });
  const userId = await repo.register(
    "projection-only@example.test",
    "synthetic-hash",
  );
  await repo.aiConsent(userId, { policy: bundle, revision: 2 });
  const threadId = (
    await f.db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  await assert.rejects(
    repo.reserveChat(
      userId,
      threadId,
      randomUUID(),
      "No actual personal data grant",
      { ...f.access, modeSnapshot: currentSnapshot },
    ),
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from ai_request_consent_bases"))
      .rows[0]?.n,
    1,
  );
});

test("SQL attempts require a real immutable basis for modes; no-mode history and Worker status updates retain their path", async (t) => {
  const f = await fixture(t),
    requestId = randomUUID();
  await f.db.query(
    "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'running',$3,2)",
    [f.thread, requestId, bundle.id],
  );
  await recordAiRequestMode(f.db, {
    userId: f.user.id,
    threadId: f.thread,
    requestId,
    consentPolicyId: bundle.id,
    routingRevision: 2,
    snapshot: f.snapshot,
  });
  const insert = () =>
    f.db.query(
      "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision) values($1,$2,1,$3,'routerai',$4,$5,2)",
      [f.thread, requestId, f.user.id, policy.model, policy.id],
    );
  await assert.rejects(insert(), /requires its immutable consent basis/);
  assert.deepEqual(
    (await f.db.query("select * from ai_model_attempts")).rows,
    [],
  );
  const grant = await legacyBalancedGrant(
    f.db,
    f.user.id,
    compatibility,
    bundle.id,
  );
  assert.ok(grant);
  await recordAiConsentBasis(f.db, {
    userId: f.user.id,
    threadId: f.thread,
    requestId,
    routingPolicyId: bundle.id,
    grant,
    legacy: true,
  });
  await insert();
  // Revocation cannot rewrite the already admitted grant or stop status cleanup.
  await f.repo.aiConsent(f.user.id, null);
  await f.db.query(
    "update chat_requests set status='interrupted' where thread_id=$1 and request_id=$2",
    [f.thread, requestId],
  );
  assert.equal(
    (
      await f.db.query(
        "select status from chat_requests where thread_id=$1 and request_id=$2",
        [f.thread, requestId],
      )
    ).rows[0]?.status,
    "interrupted",
  );
  const historical = randomUUID();
  await f.db.query(
    "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'running',$3,2)",
    [f.thread, historical, policy.id],
  );
  await f.db.query(
    "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision) values($1,$2,1,$3,'routerai',$4,$5,2)",
    [f.thread, historical, f.user.id, policy.model, policy.id],
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from ai_model_attempts")).rows[0]
      ?.n,
    2,
  );
});
test("unknown or changed mode never borrows legacy consent and failed choices leave no evidence", async (t) => {
  const f = await fixture(t);
  for (const mode of ["maximum", "minimum"] as const)
    await assert.rejects(
      f.repo.reserveChat(f.user.id, f.thread, randomUUID(), "No dispatch", {
        ...f.access,
        modeSnapshot: { ...f.snapshot, mode },
      }),
    );
  await assert.rejects(
    f.repo.reserveChat(f.user.id, f.thread, randomUUID(), "Changed recipient", {
      ...f.access,
      modeSnapshot: {
        ...f.snapshot,
        policy: { ...policy, id: h("different-policy") },
        execution: {
          ...execution,
          policy: { ...policy, id: h("different-policy") },
        },
      },
    }),
  );
  const before = (
    await f.db.query("select * from service_consent_events order by id")
  ).rows;
  for (const choice of [
    { ...f.choice, expectedUserId: "999999" },
    { ...f.choice, policyVersion: "old" },
    { ...f.choice, policyId: h("other") },
    { ...f.choice, marketing: true },
    { ...f.choice, personalData: false },
  ])
    await assert.rejects(f.store.acceptAiModes(f.user.id, choice));
  assert.deepEqual(
    (await f.db.query("select * from service_consent_events order by id")).rows,
    before,
  );
  assert.deepEqual((await f.db.query("select * from chat_requests")).rows, []);
  await f.repo.aiConsent(f.user.id, null);
  assert.equal((await f.store.state(f.user.id)).serviceConsentRequired, true);
  await assert.rejects(
    f.repo.reserveChat(f.user.id, f.thread, randomUUID(), "Revoked", f.access),
  );
});
test("stale routing confirmation rolls back; explicit full choice also records current grant and latest marketing withdrawal stays withdrawn", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "update ai_routing set provider='disabled',policy_id=null,revision=3 where id=1",
  );
  await assert.rejects(f.store.acceptAiModes(f.user.id, f.choice));
  await f.db.query(
    "update ai_routing set provider='routerai',policy_id=$1,revision=4 where id=1",
    [bundle.id],
  );
  await f.store.choose(f.user.id, {
    policyVersion: f.choice.policyVersion,
    personalData: true,
    marketing: false,
  });
  const state = await f.store.state(f.user.id);
  assert.equal(state.currentAiConsentRequired, false);
  assert.equal(state.marketingGranted, false);
  const rows = (
    await f.db.query(
      "select decision from service_consent_events where purpose='marketing' order by id desc limit 1",
    )
  ).rows;
  assert.equal(rows[0]?.decision, "withdrawn");
});

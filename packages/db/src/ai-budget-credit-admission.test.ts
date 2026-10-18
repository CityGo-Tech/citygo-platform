import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  CITYGO_10X_TARIFF,
  LEGACY_AT_COST_TARIFF,
  type AiExecution,
} from "@citygo/contracts";
import { connectDatabase, migrate, Repository, DomainError } from "./index.js";
import { AiCreditLedger } from "./ai-credit.js";
import { changeAiBudget } from "./ai-budget.js";
import { captureRestartRows } from "./closed-account-restart-fixture.js";

const execution: AiExecution = {
  key: "a".repeat(64),
  policy: {
    id: "b".repeat(64),
    provider: "routerai",
    model: "synthetic/model",
    version: "synthetic-v1",
    recipient: "synthetic-recipient",
    routing: "synthetic-routing",
    data: "synthetic-data",
  },
  maxInputBytes: 1000,
  maxOutputTokens: 100,
};
const admissionTables = [
  "account_security_state",
  "ai_budget",
  "ai_budget_daily",
  "ai_model_attempt_daily",
  "ai_user_model_attempt_daily",
  "ai_model_attempts",
  "ai_credit_accounts",
  "ai_credit_entries",
  "ai_credit_charges",
  "credit_source_lots",
  "credit_hold_allocations",
];
async function fixture(
  t: TestContext,
  mode: "fixed" | "routerai_balance" = "routerai_balance",
) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = await new Repository(db).register(
    "synthetic-admission@example.test",
    "SYNTHETIC-HASH",
  );
  const lease = randomUUID();
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key,lease_token,busy_until) values ($1,'housing',$2,clock_timestamp()+interval '10 minutes') returning id::text",
      [user, lease],
    )
  ).rows[0]!.id;
  const request = randomUUID();
  await db.query(
    "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values ($1,$2,'running',$3,1)",
    [thread, request, execution.policy.id],
  );
  await changeAiBudget(
    db,
    user,
    {
      expectedRevision: 1,
      enabled: true,
      mode,
      currency: "RUB",
      dailyLimitMicros: mode === "fixed" ? 100 : null,
      totalLimitMicros: mode === "fixed" ? 100 : null,
      userDailyLimitMicros: null,
      rules: [{ key: execution.key, attemptCeilingMicros: 10 }],
    },
    [execution],
  );
  const input = {
    userId: user,
    threadId: thread,
    requestId: request,
    lease,
    attemptNumber: 1,
    provider: "routerai" as const,
    model: execution.policy.model,
    policyId: execution.policy.id,
    routingRevision: 1,
    userDailyLimit: 10,
    globalDailyLimit: 20,
    execution,
    upstream: "synthetic-upstream",
  };
  return { db, user, input };
}

for (const charging of [false, true])
  test(`RouterAI balance admission rejects ${charging ? "at-cost tariff" : "disabled user charging"} and rolls back all counters`, async (t) => {
    const f = await fixture(t);
    const before = await captureRestartRows(f.db, admissionTables);
    const repo = new Repository(
      f.db,
      charging,
      charging ? LEGACY_AT_COST_TARIFF : CITYGO_10X_TARIFF,
    );
    await assert.rejects(
      repo.reserveAiAttempt(f.input),
      (error) =>
        error instanceof DomainError &&
        error.statusCode === 503 &&
        error.code === "AI_CREDIT_UNAVAILABLE",
    );
    assert.deepEqual(await captureRestartRows(f.db, admissionTables), before);
  });

test("RouterAI balance ×10 admission still requires existing user funds; funded admission holds exactly the approved ×10 ceiling", async (t) => {
  const f = await fixture(t);
  const repo = new Repository(f.db, true, CITYGO_10X_TARIFF);
  const before = await captureRestartRows(f.db, admissionTables);
  await assert.rejects(
    repo.reserveAiAttempt(f.input),
    (error) =>
      error instanceof DomainError && error.code === "AI_CREDIT_EXHAUSTED",
  );
  assert.deepEqual(await captureRestartRows(f.db, admissionTables), before);
  const ledger = new AiCreditLedger(f.db);
  // Synthetic trusted server proof only; no payment provider or network.
  await ledger.topUpConfirmed(f.user, randomUUID(), {
    providerPaymentId: randomUUID(),
    paidKopeks: 10_000,
    merchantId: "synthetic-shop",
    test: false,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const hold = await repo.reserveAiAttempt(f.input);
  assert.match(hold!, /^[a-f0-9-]{36}$/);
  assert.equal((await ledger.status(f.user)).heldMicros, 100);
  assert.equal(
    (await f.db.query("select 1 from ai_model_attempts")).rows.length,
    1,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select real_ceiling_micros::text as ceiling,tariff_snapshot->>'version' as tariff from ai_credit_charges where hold_id=$1",
        [hold],
      )
    ).rows,
    [{ ceiling: "10", tariff: "citygo-10x-v1" }],
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select total_reserved_micros::text as reserved from ai_budget where id=1",
      )
    ).rows,
    [{ reserved: "10" }],
  );
});

test("fixed finite operator budgets preserve the existing explicit free-AI flow", async (t) => {
  const f = await fixture(t, "fixed");
  assert.equal(
    await new Repository(f.db, false).reserveAiAttempt(f.input),
    null,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_model_attempts")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_charges")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries")).rows.length,
    0,
  );
});

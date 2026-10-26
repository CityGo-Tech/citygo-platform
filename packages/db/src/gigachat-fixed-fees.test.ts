import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  CITYGO_10X_TARIFF,
  LEGACY_AT_COST_TARIFF,
  type AiPolicy,
} from "@citygo/contracts";
import {
  AiCreditLedger,
  AccountReset,
  ClosedAccountRestart,
  DomainError,
  GigaChatFixedFees,
  FreshAccountReset,
  Repository,
  ServiceConsents,
  connectDatabase,
  migrate,
  reservePaidRefund,
  type AiRequestModeSnapshot,
  type Database,
  type GigaChatFixedFeeInput,
} from "./index.js";
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const status = (n: number) => (e: unknown) =>
  e instanceof DomainError && e.statusCode === n;
const common: AiPolicy = {
  id: h("giga-common"),
  provider: "routerai",
  model: "citygo-bundle",
  version: "synthetic-v1",
  recipient: "Synthetic",
  routing: "Synthetic",
  data: "Synthetic",
};
const policy: AiPolicy = {
  ...common,
  id: h("giga-policy"),
  provider: "gigachat",
  model: "GigaChat-3-Ultra",
  routing: "GIGACHAT_API_PERS",
};
const snapshot: AiRequestModeSnapshot = {
  mode: "minimum",
  catalogId: h("giga-catalog"),
  policy,
  execution: {
    key: h("giga-execution"),
    policy,
    maxInputBytes: 2048,
    maxOutputTokens: 64,
  },
};
const pricing: GigaChatFixedFeeInput = {
  pricingId: h("flat3"),
  accountRef: h("synthetic-account"),
  scope: "GIGACHAT_API_PERS",
};
async function fixture(t: TestContext, paid = false) {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const repo = new Repository(
    db,
    true,
    CITYGO_10X_TARIFF,
    false,
    "fixed5_overdraft",
  );
  await repo.initializeAiRouting(common);
  const routing = await repo.aiRouting();
  const consents = new ServiceConsents(db, () => common);
  const register = async (email = randomUUID() + "@example.test") =>
    (
      await consents.register(email, "synthetic", h(randomUUID()), {
        policyVersion: (await consents.policy()).version,
        personalData: true,
        marketing: false,
      })
    ).id;
  const user = await register();
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  if (paid)
    await ledger.topUpConfirmed(user, randomUUID(), {
      providerPaymentId: "synthetic-" + randomUUID(),
      merchantId: "synthetic",
      paidKopeks: 10000,
      currency: "RUB",
      test: false,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
    });
  else await ledger.grantWelcome(user, user);
  // The existing RouterAI money rules remain exact and unrelated to the free
  // provider/product-fee branch. Only the common administrative stop is shared.
  const router = {
    key: h("router-rule"),
    policy: { ...common, id: h("router-policy"), model: "synthetic/router" },
    maxInputBytes: 2048,
    maxOutputTokens: 64,
  };
  await repo.changeAiBudget(
    user,
    {
      expectedRevision: 1,
      enabled: true,
      mode: "routerai_balance",
      currency: "RUB",
      dailyLimitMicros: null,
      totalLimitMicros: null,
      userDailyLimitMicros: null,
      rules: [{ key: router.key, attemptCeilingMicros: 1000000 }],
    },
    [router],
  );
  const fees = new GigaChatFixedFees(db);
  async function begin(owner = user) {
    const existing = (
      await db.query<{ id: string }>(
        "select id::text from agent_threads where user_id=$1 and conversation_agent_key='support' and status<>'closed'",
        [owner],
      )
    ).rows[0];
    const thread =
      existing?.id ??
      (
        await db.query<{ id: string }>(
          "insert into agent_threads(user_id,agent_key,conversation_agent_key) values($1,'support','support') returning id::text",
          [owner],
        )
      ).rows[0]!.id;
    const requestId = randomUUID().toUpperCase();
    const reservation = await repo.reserveChat(
      owner,
      thread,
      requestId,
      "Question",
      {
        policyId: common.id,
        revision: routing.revision,
        userDailyLimit: 100,
        globalDailyLimit: 200,
        modeSnapshot: snapshot,
      },
    );
    const attempt = {
      userId: owner,
      threadId: thread,
      requestId,
      lease: reservation.lease,
      attemptNumber: 1,
      provider: "gigachat" as const,
      model: policy.model,
      policyId: policy.id,
      consentPolicyId: common.id,
      routingRevision: routing.revision,
      userDailyLimit: 100,
      globalDailyLimit: 200,
      execution: snapshot.execution,
      mode: { id: "minimum" as const, catalogId: snapshot.catalogId },
      fixedFee: pricing,
    };
    return { thread, requestId, reservation, attempt };
  }
  const finish = (
    r: Awaited<ReturnType<typeof begin>>,
    holdId: string,
    complete = true,
  ) =>
    repo.finishGigaChat({
      userId: user,
      threadId: r.thread,
      requestId: r.requestId,
      lease: r.reservation.lease,
      agent: "support",
      content: complete ? "Answer" : "Partial",
      complete,
      holdId,
      generation: {
        provider: "gigachat",
        requestedModel: policy.model,
        model: policy.model + ":synthetic",
      },
    });
  const money = async () =>
    (
      await db.query(`select jsonb_build_object(
 'accounts',(select jsonb_agg(to_jsonb(t) order by user_id) from ai_credit_accounts t),
 'entries',(select jsonb_agg(to_jsonb(t) order by id) from ai_credit_entries t),
 'sources',(select jsonb_agg(to_jsonb(t) order by id) from credit_source_lots t),
 'allocations',(select jsonb_agg(to_jsonb(t) order by hold_id,ordinal) from credit_hold_allocations t),
 'refunds',(select jsonb_agg(to_jsonb(t) order by refund_id) from credit_refund_allocations t),
 'routerCharges',(select jsonb_agg(to_jsonb(t) order by hold_id) from ai_credit_charges t),
 'operatorBudget',(select jsonb_agg(to_jsonb(t)) from ai_budget t),
 'operatorDaily',(select jsonb_agg(to_jsonb(t) order by usage_day) from ai_budget_daily t)) as snapshot`)
    ).rows;
  return { db, repo, ledger, fees, user, begin, finish, money, register };
}
test("Giga fixed fee holds five, charges product three only with persisted success and never fabricates RouterAI cost", async (t) => {
  const f = await fixture(t),
    r = await f.begin(),
    operatorBefore = (await f.db.query("select * from ai_budget")).rows;
  const hold = await f.repo.reserveAiAttempt(r.attempt);
  assert(hold);
  assert.deepEqual(
    (
      await f.db.query(
        "select basis,routing_policy_id,grant_policy_id from ai_request_consent_bases where thread_id=$1 and request_id=$2",
        [r.thread, r.requestId],
      )
    ).rows,
    [
      {
        basis: "current",
        routing_policy_id: common.id,
        grant_policy_id: common.id,
      },
    ],
    "a paid Minimum request has its own real bundle-consent receipt",
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5000000);
  assert.deepEqual(
    (
      await f.db.query(
        "select money_currency,money_reserved_micros,money_rule_key from ai_model_attempts",
      )
    ).rows,
    [
      {
        money_currency: null,
        money_reserved_micros: null,
        money_rule_key: null,
      },
    ],
  );
  const fee = await f.fees.get(f.user, hold);
  assert.equal(fee.snapshot.feeCitygoMicros, 3000000);
  assert.equal(fee.snapshot.operatorCostRubMicros, 0);
  await f.fees.dispatch(f.user, hold);
  const message = await f.finish(r, hold);
  const balance = await f.ledger.status(f.user);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.spentMicros, 3000000);
  assert.equal(balance.availableMicros, 497000000);
  assert.equal((await f.fees.get(f.user, hold)).responseMessageId, message);
  assert.equal(
    (await f.db.query("select * from ai_credit_charges")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select * from credit_charge_debts")).rows.length,
    0,
  );
  assert.deepEqual(
    (await f.db.query("select * from ai_budget")).rows,
    operatorBefore,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select * from gigachat_account_leases where lease_token is not null",
      )
    ).rows,
    [],
  );
  const before = await f.money();
  assert.equal(await f.finish(r, hold), message);
  assert.deepEqual(await f.money(), before);
  await assert.rejects(f.fees.dispatch(f.user, hold), status(409));
});
test("errors are free; unknown transport keeps PERS capacity and contention rolls back another user's money and attempt", async (t) => {
  const f = await fixture(t),
    r = await f.begin(),
    hold = await f.repo.reserveAiAttempt(r.attempt);
  assert(hold);
  await f.fees.dispatch(f.user, hold);
  await f.finish(r, hold, false);
  const balance = await f.ledger.status(f.user);
  assert.equal(balance.spentMicros, 0);
  assert.equal(balance.heldMicros, 0);
  assert.equal((await f.fees.get(f.user, hold)).state, "failed");
  const second = await f.register("second@example.test");
  await f.ledger.grantWelcome(second, second);
  const other = await f.begin(second),
    before = await f.money();
  await assert.rejects(f.repo.reserveAiAttempt(other.attempt), status(503));
  assert.deepEqual(await f.money(), before);
  assert.equal(
    (await f.db.query("select 1 from ai_model_attempts")).rows.length,
    1,
  );
  assert.deepEqual(await f.fees.recoverExpired(), {
    examined: 0,
    released: 0,
    cleared: 0,
  });
  await assert.rejects(f.finish(r, hold, true), status(409));
});
test("frozen mode, tariff, scope, first attempt and global stop are mandatory before any fee or balance change", async (t) => {
  const f = await fixture(t),
    r = await f.begin(),
    before = await f.money();
  const variants = [
    { ...r.attempt, fixedFee: undefined },
    { ...r.attempt, mode: undefined },
    { ...r.attempt, attemptNumber: 2 },
    { ...r.attempt, fixedFee: { ...pricing, scope: "GIGACHAT_API_B2B" } },
    { ...r.attempt, model: "GigaChat" },
    { ...r.attempt, mode: { id: "balanced", catalogId: snapshot.catalogId } },
  ];
  for (const v of variants)
    await assert.rejects(f.repo.reserveAiAttempt(v as typeof r.attempt));
  await assert.rejects(
    new Repository(
      f.db,
      true,
      LEGACY_AT_COST_TARIFF,
      false,
      "full",
    ).reserveAiAttempt(r.attempt),
    status(503),
  );
  await f.db.query("update ai_budget set enabled=false");
  const stopped = await f.money();
  await assert.rejects(f.repo.reserveAiAttempt(r.attempt), status(503));
  assert.deepEqual(await f.money(), stopped);
  await f.db.query("update ai_budget set enabled=true");
  assert.deepEqual(await f.money(), before);
});
test("failure to save final history rolls back the product posting and all source allocations", async (t) => {
  const f = await fixture(t),
    r = await f.begin(),
    hold = await f.repo.reserveAiAttempt(r.attempt);
  assert(hold);
  await f.fees.dispatch(f.user, hold);
  const before = await f.money();
  await f.db.exec(
    "create function synthetic_giga_message_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic save failure';end$$;create trigger synthetic_giga_message_failure before insert on messages for each row execute function synthetic_giga_message_failure()",
  );
  await assert.rejects(f.finish(r, hold), /synthetic save failure/);
  assert.deepEqual(await f.money(), before);
  assert.equal((await f.fees.get(f.user, hold)).state, "dispatched");
  await f.db.exec(
    "drop trigger synthetic_giga_message_failure on messages;drop function synthetic_giga_message_failure()",
  );
  await f.finish(r, hold, false);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 0);
});
test("API role can use the fee lifecycle; identities, wrong postings and Worker access remain blocked", async (t) => {
  const f = await fixture(t);
  for (const role of ["citygo_api", "citygo_worker", "citygo_backup"])
    await f.db.exec(`create role ${role} nologin`);
  await f.db.exec(
    "grant usage on schema public to citygo_api,citygo_worker,citygo_backup",
  );
  await f.db.exec(
    (
      await readFile(
        new URL("../../../deploy/postgres/grants.sql", import.meta.url),
        "utf8",
      )
    ).replace(/^\\set[^\n]*\n/gm, ""),
  );
  const api: Database = {
    ...f.db,
    query: <T>(s: string, p?: unknown[]) =>
      f.db.transaction(async (tx) => {
        await tx.exec("set local role citygo_api");
        return tx.query<T>(s, p);
      }),
    transaction: (work) =>
      f.db.transaction(async (tx) => {
        await tx.exec("set local role citygo_api");
        return work(tx);
      }),
  };
  const repo = new Repository(
      api,
      true,
      CITYGO_10X_TARIFF,
      false,
      "fixed5_overdraft",
    ),
    fees = new GigaChatFixedFees(api),
    r = await f.begin();
  const hold = await repo.reserveAiAttempt(r.attempt);
  assert(hold);
  await fees.dispatch(f.user, hold);
  const before = await f.money();
  for (const sql of [
    "update gigachat_request_fees set pricing_id=repeat('a',64)",
    "delete from gigachat_request_fees",
    "delete from gigachat_account_leases",
  ])
    await assert.rejects(
      api.query(sql),
      /permission denied|immutable|retained/,
    );
  await assert.rejects(
    new AiCreditLedger(api).resolve(f.user, randomUUID(), hold, {
      kind: "settle",
      amountMicros: 4000000,
    }),
    /Pending GigaChat fee/,
  );
  assert.deepEqual(await f.money(), before);
  for (const table of ["gigachat_request_fees", "gigachat_account_leases"])
    await assert.rejects(
      f.db.transaction(async (tx) => {
        await tx.exec("set local role citygo_worker");
        await tx.query("select 1 from " + table);
      }),
      /permission denied/,
    );
  await repo.finishGigaChat({
    userId: f.user,
    threadId: r.thread,
    requestId: r.requestId,
    lease: r.reservation.lease,
    agent: "support",
    content: "Answer",
    complete: true,
    generation: {
      provider: "gigachat",
      requestedModel: policy.model,
      model: policy.model,
    },
    holdId: hold,
  });
  assert.equal((await f.ledger.status(f.user)).spentMicros, 3000000);
});

test("the product fee spends gift first and releases held paid funds for a full unused-payment refund", async (t) => {
  const f = await fixture(t),
    full = new AiCreditLedger(f.db),
    oldHold = randomUUID();
  await full.hold(f.user, oldHold, 500000000);
  await full.resolve(f.user, randomUUID(), oldHold, {
    kind: "settle",
    amountMicros: 497000000,
  });
  const paidOperation = randomUUID();
  await f.ledger.topUpConfirmed(f.user, paidOperation, {
    providerPaymentId: "synthetic-refundable-" + randomUUID(),
    merchantId: "synthetic",
    paidKopeks: 10000,
    currency: "RUB",
    test: false,
    verifiedAt: new Date().toISOString(),
    verification: "server_get_succeeded",
  });
  const r = await f.begin(),
    hold = await f.repo.reserveAiAttempt(r.attempt);
  assert(hold);
  assert.deepEqual(
    (
      await f.db.query(
        "select l.kind,a.reserved_micros::text from credit_hold_allocations a join credit_source_lots l on l.id=a.source_lot_id where a.hold_id=$1 order by a.ordinal",
        [hold],
      )
    ).rows,
    [
      { kind: "gift", reserved_micros: "3000000" },
      { kind: "paid", reserved_micros: "2000000" },
    ],
  );
  const before = await f.money();
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await f.fees.lockAccount(tx, f.user);
      return reservePaidRefund(tx, f.user, paidOperation, randomUUID(), 10000);
    }),
    status(409),
  );
  assert.deepEqual(await f.money(), before);
  await f.fees.dispatch(f.user, hold);
  await f.finish(r, hold);
  assert.deepEqual(
    (
      await f.db.query(
        "select l.kind,a.spent_micros::text,a.state from credit_hold_allocations a join credit_source_lots l on l.id=a.source_lot_id where a.hold_id=$1 order by a.ordinal",
        [hold],
      )
    ).rows,
    [
      { kind: "gift", spent_micros: "3000000", state: "settled" },
      { kind: "paid", spent_micros: "0", state: "settled" },
    ],
  );
  const refund = await f.db.transaction(async (tx) => {
    await f.fees.lockAccount(tx, f.user);
    return reservePaidRefund(tx, f.user, paidOperation, randomUUID(), 10000);
  });
  assert.equal(refund.amountKopeks, 10000);
  assert.equal(refund.state, "reserved");
});

test("real admitted fee and capacity evidence block all account reset plans without changing financial or proof rows", async (t) => {
  const f = await fixture(t),
    r = await f.begin(),
    hold = await f.repo.reserveAiAttempt(r.attempt);
  assert(hold);
  const before = await f.money(),
    options = { expectedUserCount: 1, maintenanceConfirmed: true as const };
  const plans = [
    await new AccountReset(f.db).plan(options),
    await new ClosedAccountRestart(f.db).plan(options),
    await new FreshAccountReset(f.db).plan(options),
  ];
  for (const p of plans) {
    assert.equal(p.counts.gigachat_request_fees, 1);
    assert.equal(p.counts.gigachat_account_leases, 1);
    assert(
      p.blockers.some(
        (b) => b.code === "GIGACHAT_HISTORY_REQUIRES_REVIEW" && b.count === 2,
      ),
    );
  }
  assert.deepEqual(await f.money(), before);
});

test("isolated aged-lease fixture recovers a crashed request for zero once and fences late callbacks before a new lease", async (t) => {
  const f = await fixture(t),
    r = await f.begin(),
    hold = await f.repo.reserveAiAttempt(r.attempt);
  assert(hold);
  await f.fees.dispatch(f.user, hold);
  const oldToken = (await f.fees.get(f.user, hold)).leaseToken;
  // PGlite-only fixture construction simulates elapsed time without adding a
  // runtime clock override or a lease-renewal/bypass method. Re-enable both
  // identity guards before exercising the real recovery implementation.
  await f.db.transaction(async (tx) => {
    await tx.exec(
      "alter table gigachat_request_fees disable trigger gigachat_request_fee_guard;alter table gigachat_account_leases disable trigger gigachat_account_lease_guard",
    );
    await tx.query(
      "update gigachat_request_fees set created_at=clock_timestamp()-interval '181 seconds',expires_at=clock_timestamp()-interval '1 second' where hold_id=$1",
      [hold],
    );
    await tx.query(
      "update gigachat_account_leases set expires_at=f.expires_at from gigachat_request_fees f where gigachat_account_leases.hold_id=f.hold_id and f.hold_id=$1",
      [hold],
    );
    await tx.exec(
      "set constraints gigachat_request_fee_conservation immediate",
    );
    await tx.exec(
      "alter table gigachat_request_fees enable trigger gigachat_request_fee_guard;alter table gigachat_account_leases enable trigger gigachat_account_lease_guard",
    );
  });
  assert(
    (
      await f.db.query<{ enabled: string }>(
        "select tgenabled as enabled from pg_trigger where tgname in ('gigachat_request_fee_guard','gigachat_account_lease_guard')",
      )
    ).rows.every((v) => v.enabled === "O"),
  );
  assert.deepEqual(await f.fees.recoverExpired(), {
    examined: 1,
    released: 1,
    cleared: 1,
  });
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 0);
  const before = await f.money();
  await assert.rejects(f.finish(r, hold), status(409));
  assert.deepEqual(await f.money(), before);
  assert.deepEqual(await f.fees.recoverExpired(), {
    examined: 0,
    released: 0,
    cleared: 0,
  });
  const next = await f.begin(),
    newHold = await f.repo.reserveAiAttempt(next.attempt);
  assert(newHold);
  assert.notEqual((await f.fees.get(f.user, newHold)).leaseToken, oldToken);
  await assert.rejects(f.fees.dispatch(f.user, hold), status(409));
  assert.equal(
    (
      await f.db.query<{ hold: string }>(
        "select hold_id::text as hold from gigachat_account_leases where lease_token is not null",
      )
    ).rows[0]!.hold,
    newHold,
  );
});

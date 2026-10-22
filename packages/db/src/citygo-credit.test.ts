import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { seedRestartFixture } from "./closed-account-restart-fixture.js";
import {
  CITYGO_10X_TARIFF,
  LEGACY_AT_COST_TARIFF,
  CITYGO_MAX_AMOUNT_MICROS,
  aiCreditResponseSchema,
  routerAiCostMicros,
  routerAiChargeSchema,
  type RouterAiCharge,
} from "@citygo/contracts";
import { AiCreditLedger } from "./ai-credit.js";
import { AiCreditCharges } from "./ai-credit-charges.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "./index.js";

const RUB = 1_000_000;
const proof = (paymentId = randomUUID(), kopeks = 10_000) => ({
  providerPaymentId: paymentId,
  paidKopeks: kopeks,
  merchantId: "synthetic-shop",
  test: false,
  verifiedAt: "2026-10-18T00:00:00.000Z",
  verification: "server_get_succeeded" as const,
  currency: "RUB" as const,
});

test("ledger top-up availability supports legacy booleans and fresh async status without caching", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = await new Repository(db).register(
    "availability@example.test",
    "SYNTHETIC-HASH",
  );
  assert.equal(
    (await new AiCreditLedger(db, "not_connected", true).status(user))
      .topUpAvailable,
    true,
  );
  assert.equal(
    (await new AiCreditLedger(db).status(user)).topUpAvailable,
    false,
  );
  let available = false,
    calls = 0;
  const ledger = new AiCreditLedger(db, "routerai_citygo_10x", async () => {
    calls++;
    await db.query("select 1");
    return available;
  });
  assert.equal((await ledger.status(user)).topUpAvailable, false);
  available = true;
  assert.equal((await ledger.status(user)).topUpAvailable, true);
  assert.equal(calls, 2);
  const unavailable = new AiCreditLedger(db, "not_connected", async () => {
    throw new Error("synthetic admission unavailable");
  });
  await assert.rejects(
    unavailable.status(user),
    /synthetic admission unavailable/,
  );
});

test("dashboard resolves async admission before its snapshot transaction and passes a boolean to ledger", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = await new Repository(db).register(
    "dashboard-availability@example.test",
    "SYNTHETIC-HASH",
  );
  let inTransaction = false,
    available = false,
    calls = 0;
  const wrapped: Database = {
    exec: (sql) => db.exec(sql),
    query: (sql, params) => db.query(sql, params),
    close: () => db.close(),
    transaction: (work) =>
      db.transaction(async (tx) => {
        inTransaction = true;
        try {
          return await work(tx);
        } finally {
          inTransaction = false;
        }
      }),
  };
  const repo = new Repository(wrapped, false, CITYGO_10X_TARIFF, async () => {
    calls++;
    assert.equal(inTransaction, false);
    await db.query("select 1");
    return available;
  });
  const account = { id: user, email: "dashboard-availability@example.test" };
  assert.equal(
    (await repo.dashboard(account, "unconfigured", null, 20)).aiAccess.credit!
      .topUpAvailable,
    false,
  );
  available = true;
  assert.equal(
    (await repo.dashboard(account, "unconfigured", null, 20)).aiAccess.credit!
      .topUpAvailable,
    true,
  );
  assert.equal(calls, 2);
});

test("0014 upgrades existing receipts without changing postings or repricing legacy operations", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0014_")
    .sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  const seeded = await seedRestartFixture(db);
  const before = (await db.query("select * from ai_credit_entries order by id"))
    .rows;
  await db.exec(
    await readFile(new URL("0014_citygo_credit.sql", directory), "utf8"),
  );
  assert.deepEqual(
    (await db.query("select * from ai_credit_entries order by id")).rows,
    before,
  );
  const charges = new AiCreditCharges(db, CITYGO_10X_TARIFF);
  const restored = await charges.get(seeded.user, seeded.hold);
  assert.deepEqual(restored.receipt, seeded.receipt);
  assert.deepEqual(restored.tariff_snapshot, LEGACY_AT_COST_TARIFF);
  assert.equal(Number(restored.real_ceiling_micros), RUB);
  await charges.settle(
    seeded.user,
    seeded.hold,
    routerAiChargeSchema.parse(seeded.receipt),
  );
  assert.deepEqual(
    (await db.query("select * from ai_credit_entries order by id")).rows,
    before,
  );
});
async function fixture() {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const repo = new Repository(db);
  const user = await repo.register(
    "credit@example.test",
    "SYNTHETIC-NOT-A-PASSWORD",
  );
  const other = await repo.register(
    "other@example.test",
    "SYNTHETIC-NOT-A-PASSWORD",
  );
  const ledger = new AiCreditLedger(db, "routerai_citygo_10x");
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values ($1,'housing') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  const input = async () => {
    const requestId = randomUUID();
    await db.query(
      "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values ($1,$2,'complete',$3,1)",
      [thread, requestId, "a".repeat(64)],
    );
    await db.query(
      "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key) values ($1,$2,1,$3,'routerai','test/model',$4,1,'RUB',1000000,1,$4)",
      [thread, requestId, user, "a".repeat(64)],
    );
    return {
      userId: user,
      threadId: thread,
      requestId,
      model: "test/model",
      upstream: "test-upstream",
    };
  };
  const reserve = async (charges: AiCreditCharges, ceiling = 2 * RUB) => {
    const value = await input();
    return db.transaction((tx) => charges.reserve(tx, value, ceiling));
  };
  const completed = async (
    charges: AiCreditCharges,
    hold: string,
    costRub: string,
  ) => {
    const generationId = "synthetic-" + randomUUID();
    await charges.dispatch(user, hold);
    await charges.identify(user, hold, generationId);
    await db.query(
      "update ai_credit_charges set response_complete=true where hold_id=$1",
      [hold],
    );
    return {
      generationId,
      reference: hold,
      model: "test/model",
      upstream: "test-upstream",
      currency: "RUB",
      costRub,
      amountMicros: routerAiCostMicros(costRub),
    } satisfies RouterAiCharge;
  };
  return { db, user, other, ledger, input, reserve, completed };
}

test("confirmed top-up is 1:1, never implies bonus, and replays once", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const operation = randomUUID(),
    payment = proof();
  const first = await f.ledger.topUpConfirmed(f.user, operation, payment);
  assert.equal(first.grantedMicros, 100 * RUB);
  assert.equal(first.bonusGranted, false);
  assert.equal(first.history[0]!.kind, "topup");
  assert.ok(aiCreditResponseSchema.safeParse(first).success);
  await f.ledger.topUpConfirmed(f.user, operation, payment);
  await f.ledger.topUpConfirmed(f.user, randomUUID(), {
    ...payment,
    verifiedAt: "2026-10-18T01:00:00.000Z",
  });
  assert.equal((await f.ledger.status(f.user)).grantedMicros, 100 * RUB);
  assert.equal(
    (await f.db.query("select * from ai_credit_topups")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select * from ai_credit_entries")).rows.length,
    1,
  );
  assert.deepEqual(
    (
      await f.db.query<{ verification_receipt: unknown }>(
        "select verification_receipt from ai_credit_topups",
      )
    ).rows[0]!.verification_receipt,
    payment,
  );
});

test("malformed payment proofs never create money or a credit account", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const valid = proof();
  for (const raw of [
    { ...valid, paidKopeks: 0 },
    { ...valid, paidKopeks: -1 },
    { ...valid, paidKopeks: 0.1 },
    { ...valid, paidKopeks: 1_000_000_001 },
    { ...valid, currency: "USD" },
    { ...valid, verification: "client_return" },
    { ...valid, merchantId: "" },
    { ...valid, providerPaymentId: "../bad" },
    { ...valid, verifiedAt: "not-a-date" },
    { ...valid, amount: 100 },
  ])
    await assert.rejects(
      f.ledger.topUpConfirmed(
        f.user,
        randomUUID(),
        raw as Parameters<AiCreditLedger["topUpConfirmed"]>[2],
      ),
    );
  assert.equal(
    (await f.db.query("select * from ai_credit_accounts")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select * from ai_credit_entries")).rows.length,
    0,
  );
});

test("top-up binds global payment, operation, owner, amount, merchant and mode", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const operation = randomUUID(),
    payment = proof();
  await f.ledger.topUpConfirmed(f.user, operation, payment);
  for (const patch of [
    { paidKopeks: 9999 },
    { merchantId: "other-shop" },
    { test: true },
  ])
    await assert.rejects(
      f.ledger.topUpConfirmed(f.user, randomUUID(), { ...payment, ...patch }),
    );
  await assert.rejects(f.ledger.topUpConfirmed(f.other, randomUUID(), payment));
  await assert.rejects(f.ledger.topUpConfirmed(f.user, operation, proof()));
  const hold = randomUUID();
  await f.ledger.hold(f.user, hold, RUB);
  await assert.rejects(f.ledger.topUpConfirmed(f.user, hold, proof()));
  assert.equal((await f.ledger.status(f.user)).grantedMicros, 100 * RUB);
  assert.equal((await f.ledger.status(f.other)).grantedMicros, 0);
});

test("paid funds survive one-time welcome, values exceed 500 and remain bounded", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(
    f.user,
    randomUUID(),
    proof(randomUUID(), 60_000),
  );
  await f.ledger.grantWelcome(f.user, f.other);
  await f.ledger.grantWelcome(f.user, f.other);
  const status = await f.ledger.status(f.user);
  assert.equal(status.grantedMicros, 1100 * RUB);
  assert.equal(status.bonusGranted, true);
  assert.ok(aiCreditResponseSchema.safeParse(status).success);
  assert.equal(status.history.filter((e) => e.kind === "bonus").length, 1);
  await f.db.query(
    "update ai_credit_accounts set granted_micros=$2 where user_id=$1",
    [f.user, CITYGO_MAX_AMOUNT_MICROS],
  );
  await assert.rejects(f.ledger.topUpConfirmed(f.user, randomUUID(), proof()));
  assert.equal(
    (await f.db.query("select * from ai_credit_topups")).rows.length,
    1,
  );
});

test("parallel repeats cannot create two top-ups", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const operation = randomUUID(),
    payment = proof();
  await Promise.all(
    Array.from({ length: 8 }, () =>
      f.ledger.topUpConfirmed(f.user, operation, payment),
    ),
  );
  assert.equal((await f.ledger.status(f.user)).grantedMicros, 100 * RUB);
  assert.equal(
    (await f.db.query("select * from ai_credit_topups")).rows.length,
    1,
  );
});

test("top-up write failure rolls back account, entry and receipt", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const broken: Database = {
    ...f.db,
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            if (sql.includes("insert into ai_credit_topups"))
              throw new Error("synthetic-write-failure");
            return tx.query<T>(sql, params);
          },
        }),
      ),
  };
  await assert.rejects(
    new AiCreditLedger(broken).topUpConfirmed(f.user, randomUUID(), proof()),
    /synthetic-write-failure/,
  );
  assert.equal((await f.ledger.status(f.user)).grantedMicros, 0);
  assert.equal(
    (await f.db.query("select * from ai_credit_entries")).rows.length,
    0,
  );
});

test("10x reservation and settlement preserve original receipt and durable tariff", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), proof());
  const charges = new AiCreditCharges(f.db, CITYGO_10X_TARIFF);
  const hold = await f.reserve(charges);
  assert.equal((await f.ledger.status(f.user)).heldMicros, 20 * RUB);
  const receipt = await f.completed(charges, hold, "1.23456789");
  const replay = new AiCreditCharges(f.db, LEGACY_AT_COST_TARIFF);
  await replay.settle(f.user, hold, receipt);
  await replay.settle(f.user, hold, receipt);
  const state = await f.ledger.status(f.user);
  assert.equal(state.spentMicros, 12_345_678);
  assert.equal(state.heldMicros, 0);
  const persisted = await replay.get(f.user, hold);
  assert.deepEqual(persisted.receipt, receipt);
  assert.deepEqual(persisted.tariff_snapshot, CITYGO_10X_TARIFF);
  assert.equal(Number(persisted.real_ceiling_micros), 2 * RUB);
});

test("legacy default retains at-cost settlement after process switches to 10x", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), proof());
  const charges = new AiCreditCharges(f.db);
  const hold = await f.reserve(charges);
  assert.equal((await f.ledger.status(f.user)).heldMicros, 2 * RUB);
  const receipt = await f.completed(charges, hold, "1.23456789");
  await new AiCreditCharges(f.db, CITYGO_10X_TARIFF).settle(
    f.user,
    hold,
    receipt,
  );
  assert.equal((await f.ledger.status(f.user)).spentMicros, 1_234_567);
});

test("sub-micro provider cost is multiplied before rounding CityGo debit", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), proof());
  const charges = new AiCreditCharges(f.db, CITYGO_10X_TARIFF),
    hold = await f.reserve(charges);
  await charges.settle(
    f.user,
    hold,
    await f.completed(charges, hold, "0.00000019"),
  );
  assert.equal((await f.ledger.status(f.user)).spentMicros, 1);
});

test("exact cost above ceiling disables spend, retains hold even when floor fits", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), proof());
  await f.db.query(
    "update ai_budget set enabled=true,currency='RUB',daily_limit_micros=1,total_limit_micros=1,rules='[{}]' where id=1",
  );
  const charges = new AiCreditCharges(f.db, CITYGO_10X_TARIFF),
    hold = await f.reserve(charges, RUB);
  const receipt = await f.completed(charges, hold, "1.00000009");
  await assert.rejects(charges.settle(f.user, hold, receipt));
  assert.equal((await f.ledger.status(f.user)).heldMicros, 10 * RUB);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 0);
  assert.equal(
    (await f.db.query<{ enabled: boolean }>("select enabled from ai_budget"))
      .rows[0]!.enabled,
    false,
  );
  assert.equal((await charges.get(f.user, hold)).receipt, null);
});

test("insufficient scaled balance rolls back; nullable ceiling cannot bypass 10x", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), proof(randomUUID(), 100));
  const charges = new AiCreditCharges(f.db, CITYGO_10X_TARIFF);
  await assert.rejects(f.reserve(charges));
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
  assert.equal(
    (await f.db.query("select * from ai_credit_charges")).rows.length,
    0,
  );
  const value = await f.input(),
    hold = randomUUID();
  await f.ledger.hold(f.user, hold, 1);
  await assert.rejects(
    f.db.query(
      "insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,tariff_snapshot) values ($1,$2,$3,$4,1,$5,$6,$7)",
      [
        hold,
        f.user,
        value.threadId,
        value.requestId,
        value.model,
        value.upstream,
        JSON.stringify(CITYGO_10X_TARIFF),
      ],
    ),
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { CITYGO_10X_TARIFF, routerAiCostMicros } from "@citygo/contracts";
import { AiCreditCharges } from "./ai-credit-charges.js";
import { AiCreditLedger } from "./ai-credit.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";
import {
  listPaidSourceLots,
  reservePaidRefund,
  releasePaidRefund,
} from "./credit-source-lots.js";

const RUB = 1_000_000;
async function fixture(t: TestContext, kopeks = 650) {
  const base = process.env.TEST_DATABASE_URL;
  const database = "credit_debt_test_" + randomUUID().replaceAll("-", "");
  assert.match(database, /^credit_debt_test_[a-f0-9]{32}$/);
  let admin: Database | undefined,
    created = false;
  const connections: Database[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [
      ...connections.map((connection) => () => connection.close()),
      async () => {
        if (created) await admin!.query(`drop database "${database}"`);
      },
      async () => admin?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Synthetic overdraft cleanup failed");
  });
  let url = "pglite://:memory:";
  if (base) {
    const parsed = new URL(base);
    assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
    assert.ok(
      ((parsed.port || "5432") === "5432" &&
        parsed.pathname === "/citygo_test") ||
        (parsed.port === "55438" && parsed.pathname === "/citygo_synthetic"),
    );
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    admin = await connectDatabase(base);
    await admin.query(`create database "${database}" template template0`);
    created = true;
    parsed.pathname = "/" + database;
    url = parsed.toString();
  }
  const db = await connectDatabase(url);
  connections.push(db);
  await migrate(db);
  const user = await new Repository(db).register(
    "debt@example.test",
    "synthetic",
  );
  const other = await new Repository(db).register(
    "other@example.test",
    "synthetic",
  );
  const ledger = new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  );
  const charges = new AiCreditCharges(
    db,
    CITYGO_10X_TARIFF,
    "fixed5_overdraft",
  );
  const thread = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'support') returning id::text",
      [user],
    )
  ).rows[0]!.id;
  async function topup(amountKopeks: number) {
    const operation = randomUUID();
    const proof = {
      providerPaymentId: randomUUID(),
      paidKopeks: amountKopeks,
      merchantId: "synthetic-shop",
      test: false,
      verifiedAt: "2026-10-21T00:00:00.000Z",
      verification: "server_get_succeeded" as const,
      currency: "RUB" as const,
    };
    await ledger.topUpConfirmed(user, operation, proof);
    return { operation, proof };
  }
  const initial = await topup(kopeks);
  async function prepare(ceiling = 6 * RUB) {
    const request = randomUUID();
    await db.query(
      "insert into chat_requests(thread_id,request_id,status,ai_policy_id,ai_routing_revision) values($1,$2,'complete',$3,1)",
      [thread, request, "a".repeat(64)],
    );
    await db.query(
      "insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key) values($1,$2,1,$3,'routerai','test/model',$4,1,'RUB',$5,1,$4)",
      [thread, request, user, "a".repeat(64), ceiling],
    );
    return {
      userId: user,
      threadId: thread,
      requestId: request,
      model: "test/model",
      upstream: "synthetic",
    };
  }
  async function reserve(using = charges, ceiling = 6 * RUB) {
    const input = await prepare(ceiling);
    return db.transaction((tx) => using.reserve(tx, input, ceiling));
  }
  async function complete(hold: string, cost: string, using = charges) {
    const generationId = "synthetic-" + randomUUID();
    await using.dispatch(user, hold);
    await using.identify(user, hold, generationId);
    await db.query(
      "update ai_credit_charges set response_complete=true where hold_id=$1",
      [hold],
    );
    return {
      generationId,
      reference: hold,
      model: "test/model",
      upstream: "synthetic",
      currency: "RUB" as const,
      costRub: cost,
      amountMicros: routerAiCostMicros(cost),
    };
  }
  async function locked<T>(work: (tx: Sql) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.query("select id from users where id=$1 for update", [user]);
      await tx.query(
        "select user_id from ai_credit_accounts where user_id=$1 for update",
        [user],
      );
      return work(tx);
    });
  }
  return {
    db,
    user,
    other,
    ledger,
    charges,
    initial,
    topup,
    reserve,
    complete,
    locked,
    prepare,
    async independent() {
      assert.ok(base, "Independent transactions require opt-in PostgreSQL");
      const peer = await connectDatabase(url);
      connections.push(peer);
      return peer;
    },
  };
}

test("fixed5 posts exact full cost, funds free sources, carries bounded negative and repays future top-ups once", async (t) => {
  const f = await fixture(t);
  const hold = await f.reserve();
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  await f.charges.settle(f.user, hold, await f.complete(hold, "1.2"));
  let status = await f.ledger.status(f.user);
  assert.equal(status.spentMicros, 12 * RUB);
  assert.equal(status.availableMicros, -5_500_000);
  assert.equal(status.outstandingDebtMicros, 5_500_000);
  assert.equal(status.heldMicros, 0);
  await assert.rejects(f.reserve());
  const partial = await f.topup(200);
  await f.ledger.topUpConfirmed(f.user, partial.operation, partial.proof);
  status = await f.ledger.status(f.user);
  assert.equal(status.grantedMicros, 8_500_000);
  assert.equal(status.spentMicros, 12 * RUB);
  assert.equal(status.availableMicros, -3_500_000);
  assert.equal(status.outstandingDebtMicros, 3_500_000);
  await assert.rejects(
    f.locked((tx) =>
      reservePaidRefund(tx, f.user, partial.operation, randomUUID(), 1),
    ),
  );
  await f.topup(1000);
  status = await f.ledger.status(f.user);
  assert.equal(status.spentMicros, 12 * RUB);
  assert.equal(status.availableMicros, 6_500_000);
  assert.equal(status.outstandingDebtMicros, 0);
  const lots = await listPaidSourceLots(f.db, f.user);
  assert.deepEqual(
    lots.map((lot) => lot.spentMicros),
    [6_500_000, 2_000_000, 3_500_000],
  );
  assert.equal(lots.at(-1)!.availableMicros, 6_500_000);
  const replay = await f.charges.get(f.user, hold);
  await f.charges.settle(f.user, hold, replay.receipt!);
  assert.deepEqual(await f.ledger.status(f.user), status);
  assert.ok(await f.reserve());
});

test("extra charge uses gift before paid FIFO and does not double count actual spending", async (t) => {
  const f = await fixture(t, 10000);
  await f.ledger.grantWelcome(f.user, f.other);
  const hold = await f.reserve();
  await f.charges.settle(f.user, hold, await f.complete(hold, "6"));
  const status = await f.ledger.status(f.user);
  assert.equal(status.spentMicros, 60 * RUB);
  assert.equal(status.availableMicros, 540 * RUB);
  assert.equal(status.outstandingDebtMicros, 0);
  const lots = (
    await f.db.query<{ kind: string; spent: string }>(
      "select kind,spent_micros::text as spent from credit_source_lots where user_id=$1 order by kind",
      [f.user],
    )
  ).rows;
  assert.deepEqual(lots, [
    { kind: "gift", spent: String(60 * RUB) },
    { kind: "paid", spent: "0" },
  ]);
});

test("unknown fixed5 and old full holds block another risk attempt; old snapshots settle unchanged", async (t) => {
  const f = await fixture(t, 10000);
  const full = new AiCreditCharges(f.db, CITYGO_10X_TARIFF);
  const old = await f.reserve(full);
  const accepted = await full.get(f.user, old);
  await assert.rejects(f.reserve());
  await f.charges.settle(f.user, old, await f.complete(old, "0.7", full));
  const saved = await f.charges.get(f.user, old);
  assert.equal(saved.reservation_mode, "full");
  assert.equal(saved.real_ceiling_micros, accepted.real_ceiling_micros);
  assert.deepEqual(saved.tariff_snapshot, accepted.tariff_snapshot);
  const next = await f.reserve();
  await f.charges.dispatch(f.user, next);
  await assert.rejects(f.reserve());
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  assert.equal((await f.ledger.status(f.user)).outstandingDebtMicros, 0);
});

test("refund cancellation releases its protected source to existing debt instead of refunding consumed money", async (t) => {
  const f = await fixture(t, 2000);
  const refund = randomUUID();
  await f.locked((tx) =>
    reservePaidRefund(tx, f.user, f.initial.operation, refund, 1000),
  );
  const hold = await f.reserve();
  await f.charges.settle(f.user, hold, await f.complete(hold, "2"));
  assert.equal((await f.ledger.status(f.user)).outstandingDebtMicros, 10 * RUB);
  await f.locked((tx) => releasePaidRefund(tx, f.user, refund));
  const status = await f.ledger.status(f.user);
  assert.equal(status.outstandingDebtMicros, 0);
  assert.equal(status.availableMicros, 0);
  assert.equal(status.spentMicros, 20 * RUB);
  assert.equal((await listPaidSourceLots(f.db, f.user))[0]!.availableMicros, 0);
});

test("new gift atomically pays an existing debt; posting still credits exactly 500", async (t) => {
  const f = await fixture(t, 500);
  const hold = await f.reserve();
  await f.charges.settle(f.user, hold, await f.complete(hold, "6"));
  assert.equal((await f.ledger.status(f.user)).outstandingDebtMicros, 55 * RUB);
  await f.ledger.grantWelcome(f.user, f.other);
  const status = await f.ledger.status(f.user);
  assert.equal(status.outstandingDebtMicros, 0);
  assert.equal(status.grantedMicros, 505 * RUB);
  assert.equal(status.spentMicros, 60 * RUB);
  assert.equal(status.availableMicros, 445 * RUB);
});

test("fixed5 exact ceiling, receipt and immutable SQL guards cannot become arbitrary debt", async (t) => {
  const f = await fixture(t, 500);
  await assert.rejects(f.reserve(f.charges, 6 * RUB + 1));
  const hold = await f.reserve();
  await assert.rejects(
    f.ledger.resolve(f.user, randomUUID(), hold, {
      kind: "settle",
      amountMicros: 6 * RUB,
    }),
  );
  await assert.rejects(
    f.db.query(
      "update ai_credit_charges set reservation_mode='full' where hold_id=$1",
      [hold],
    ),
  );
  await assert.rejects(
    f.db.query(
      "update ai_credit_accounts set spent_micros=6000000 where user_id=$1",
      [f.user],
    ),
  );
  await f.charges.settle(f.user, hold, await f.complete(hold, "6"));
  await assert.rejects(
    f.db.query(
      "update credit_charge_debts set principal_micros=1 where hold_id=$1",
      [hold],
    ),
  );
  const debt = (
    await f.db.query<{ principal: string }>(
      "select principal_micros::text as principal from credit_charge_debts where hold_id=$1",
      [hold],
    )
  ).rows[0]!;
  assert.equal(debt.principal, String(55 * RUB));
  assert.equal((await f.ledger.status(f.user)).availableMicros, -55 * RUB);
  await f.topup(100);
  await assert.rejects(
    f.db.query(
      "update credit_debt_repayments set amount_micros=1 where user_id=$1",
      [f.user],
    ),
  );
  await assert.rejects(
    f.db.query("update ai_credit_charges set receipt=null where hold_id=$1", [
      hold,
    ]),
  );
});

test("fixed5 exact real overrun stops spend and retains the unknown 5-CityGo hold", async (t) => {
  const f = await fixture(t, 10000);
  await f.db.query(
    "update ai_budget set enabled=true,currency='RUB',daily_limit_micros=1,total_limit_micros=1,rules='[{}]' where id=1",
  );
  const hold = await f.reserve();
  await assert.rejects(
    f.charges.settle(f.user, hold, await f.complete(hold, "6.00000009")),
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
  assert.equal((await f.ledger.status(f.user)).spentMicros, 0);
  assert.equal(
    (await f.db.query<{ enabled: boolean }>("select enabled from ai_budget"))
      .rows[0]!.enabled,
    false,
  );
  assert.equal((await f.charges.get(f.user, hold)).receipt, null);
  await assert.rejects(f.reserve());
});

test("one-micro CityGo debt keeps exact post-ratio floor and paid source dust", async (t) => {
  const f = await fixture(t, 500);
  const hold = await f.reserve();
  await f.charges.settle(f.user, hold, await f.complete(hold, "0.50000019"));
  assert.equal((await f.ledger.status(f.user)).spentMicros, 5_000_001);
  assert.equal((await f.ledger.status(f.user)).outstandingDebtMicros, 1);
  await f.topup(1);
  const status = await f.ledger.status(f.user);
  assert.equal(status.spentMicros, 5_000_001);
  assert.equal(status.outstandingDebtMicros, 0);
  assert.equal(status.availableMicros, 9_999);
  const lot = (await listPaidSourceLots(f.db, f.user)).at(-1)!;
  assert.equal(lot.spentMicros, 1);
  assert.equal(lot.availableMicros, 9_999);
  await assert.rejects(
    f.locked((tx) =>
      reservePaidRefund(tx, f.user, lot.sourceOperationId, randomUUID(), 1),
    ),
  );
});

test("fixed5 refuses before transport if a maximum accepted debit would overflow the public counter", async (t) => {
  const f = await fixture(t, 1_000_000_000);
  await f.db.transaction(async (tx) => {
    await tx.query(
      "update ai_credit_accounts set spent_micros=granted_micros-5000000 where user_id=$1",
      [f.user],
    );
    await tx.query(
      "update credit_source_lots set spent_micros=gross_micros-5000000 where user_id=$1",
      [f.user],
    );
  });
  await assert.rejects(f.reserve(), /технический предел/);
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
});

test(
  "independent PostgreSQL transactions allow only one unresolved fixed5 risk attempt",
  {
    skip: process.env.TEST_DATABASE_URL
      ? false
      : "Requires opt-in disposable PostgreSQL; PGlite is not concurrency evidence",
    timeout: 60_000,
  },
  async (t) => {
    const f = await fixture(t, 10000);
    const peer = await f.independent();
    const firstInput = await f.prepare(),
      secondInput = await f.prepare();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function within<T>(work: Promise<T>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Synthetic overdraft barrier timed out")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    const outcome = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    let paused = false;
    const first = outcome(
      f.db.transaction((tx) =>
        f.charges.reserve(
          {
            ...tx,
            query: async <T>(sql: string, params?: unknown[]) => {
              const result = await tx.query<T>(sql, params);
              if (
                !paused &&
                sql.includes("select user_id from ai_credit_accounts")
              ) {
                paused = true;
                enter();
                await released;
              }
              return result;
            },
          },
          firstInput,
          6 * RUB,
        ),
      ),
    );
    let second: ReturnType<typeof outcome<string>> | undefined;
    let blocked = false;
    try {
      await within(entered);
      const peerCharges = new AiCreditCharges(
        peer,
        CITYGO_10X_TARIFF,
        "fixed5_overdraft",
      );
      second = outcome(
        peer.transaction((tx) => peerCharges.reserve(tx, secondInput, 6 * RUB)),
      );
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const waits = await f.db.query(
          "select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'",
        );
        if (waits.rows.length) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      release();
    }
    const results = await within(Promise.all([first, second]));
    assert.equal(blocked, true, "Real lock wait must be observed");
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(results[1]!.status, "rejected");
    assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
    assert.equal(
      (
        await f.db.query(
          "select hold_id from ai_credit_charges where user_id=$1",
          [f.user],
        )
      ).rows.length,
      1,
    );
  },
);

test("automatic legacy completion releases an all-balance hold once using its durable exact tariff", async (t) => {
  const f = await fixture(t, 500);
  const hold = await f.reserve();
  assert.equal((await f.ledger.status(f.user)).availableMicros, 0);
  assert.deepEqual(await f.charges.completedUnresolvedAfter(), []);
  const receipt = await f.complete(hold, "0.1000000123");
  assert.deepEqual(await f.charges.completedUnresolvedAfter(), [
    { holdId: hold, userId: f.user },
  ]);
  assert.equal(
    await f.charges.settleCompletedAutomatically(f.user, hold, receipt),
    true,
  );
  assert.equal(
    await f.charges.settleCompletedAutomatically(f.user, hold, receipt),
    true,
  );
  const status = await f.ledger.status(f.user);
  assert.equal(status.heldMicros, 0);
  assert.equal(status.spentMicros, 1000000);
  assert.equal(status.availableMicros, 4000000);
  assert.equal(
    (
      await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
        hold,
      ])
    ).rows.length,
    1,
  );
  assert.deepEqual(await f.charges.completedUnresolvedAfter(), []);
});

test("automatic legacy completion never finalizes zero or exceeds the accepted ceiling and never pauses the budget", async (t) => {
  const f = await fixture(t, 500),
    hold = await f.reserve();
  const receipt = await f.complete(hold, "0");
  await f.db.query(
    "update ai_budget set enabled=true,currency='RUB',daily_limit_micros=1,total_limit_micros=1,rules='[{}]' where id=1",
  );
  const before = await f.db.query("select * from ai_budget where id=1");
  for (const costRub of ["0", "0.0e+2", "6.0000001"]) {
    assert.equal(
      await f.charges.settleCompletedAutomatically(f.user, hold, {
        ...receipt,
        costRub,
        amountMicros: routerAiCostMicros(costRub),
      }),
      false,
    );
    assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
    assert.equal(
      (
        await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
          hold,
        ])
      ).rows.length,
      0,
    );
    assert.equal((await f.charges.get(f.user, hold)).receipt, null);
    assert.deepEqual(
      await f.db.query("select * from ai_budget where id=1"),
      before,
    );
  }
  assert.equal(
    (
      await f.db.query(
        "select 1 from audit_log where action='ai-credit-cost-overrun'",
      )
    ).rows.length,
    0,
  );
  assert.equal(
    await f.charges.settleCompletedAutomatically(f.user, hold, {
      ...receipt,
      costRub: "0.2",
      amountMicros: 200000,
    }),
    true,
  );
  assert.equal((await f.ledger.status(f.user)).spentMicros, 2 * RUB);
});

test("automatic legacy completion excludes an existing manual overrun even after a smaller observed cost", async (t) => {
  const f = await fixture(t),
    hold = await f.reserve();
  const receipt = await f.complete(hold, "6.0000001");
  await f.db.query(
    "update ai_budget set enabled=true,currency='RUB',daily_limit_micros=1,total_limit_micros=1,rules='[{}]' where id=1",
  );
  // Existing explicit legacy recovery keeps its original stop/audit semantics.
  await assert.rejects(
    f.charges.settle(f.user, hold.toUpperCase(), {
      ...receipt,
      reference: hold.toUpperCase(),
    }),
    { statusCode: 409 },
  );
  const before = await f.db.query("select * from ai_budget where id=1");
  const audit = await f.db.query(
    "select * from audit_log where action='ai-credit-cost-overrun'",
  );
  assert.equal(audit.rows.length, 1);
  assert.deepEqual(await f.charges.completedUnresolvedAfter(), []);
  assert.equal(
    await f.charges.settleCompletedAutomatically(f.user, hold, {
      ...receipt,
      costRub: "0.1",
      amountMicros: 100000,
    }),
    false,
  );
  assert.deepEqual(
    await f.db.query("select * from ai_budget where id=1"),
    before,
  );
  assert.deepEqual(
    await f.db.query(
      "select * from audit_log where action='ai-credit-cost-overrun'",
    ),
    audit,
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
});

test("legacy candidate pages reject incomplete, resolved and foreign identities before automatic accounting", async (t) => {
  const f = await fixture(t),
    hold = await f.reserve();
  await f.charges.dispatch(f.user, hold);
  await f.charges.identify(f.user, hold, "legacy-interrupted");
  assert.deepEqual(await f.charges.completedUnresolvedAfter(), []);
  await assert.rejects(
    f.charges.settleCompletedAutomatically(f.user, hold, {
      generationId: "legacy-interrupted",
      reference: hold,
      model: "test/model",
      upstream: "synthetic",
      currency: "RUB",
      costRub: "0.1",
      amountMicros: 100000,
    }),
    { statusCode: 409 },
  );
  await assert.rejects(
    f.charges.settleCompletedAutomatically(f.other, hold, {
      generationId: "legacy-interrupted",
      reference: hold,
      model: "test/model",
      upstream: "synthetic",
      currency: "RUB",
      costRub: "0.1",
      amountMicros: 100000,
    }),
    { statusCode: 404 },
  );
  await assert.rejects(f.charges.completedUnresolvedAfter("not-a-uuid"));
  await assert.rejects(f.charges.completedUnresolvedAfter(undefined, 21));
  assert.equal((await f.ledger.status(f.user)).heldMicros, 5 * RUB);
});

test(
  "PostgreSQL automatic legacy receipt replay across two connections posts exactly one resolution",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const f = await fixture(t, 500),
      hold = await f.reserve();
    const receipt = await f.complete(hold, "0.1"),
      peer = await f.independent();
    const second = new AiCreditCharges(
      peer,
      CITYGO_10X_TARIFF,
      "fixed5_overdraft",
    );
    const outcomes = await Promise.all([
      f.charges.settleCompletedAutomatically(f.user, hold, receipt),
      second.settleCompletedAutomatically(f.user, hold, receipt),
    ]);
    assert.deepEqual(outcomes, [true, true]);
    assert.equal(
      (
        await f.db.query("select 1 from ai_credit_entries where hold_id=$1", [
          hold,
        ])
      ).rows.length,
      1,
    );
    assert.equal((await f.ledger.status(f.user)).spentMicros, RUB);
    assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
  },
);

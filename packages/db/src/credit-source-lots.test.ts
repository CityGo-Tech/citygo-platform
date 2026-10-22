import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
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
  settlePaidRefund,
  releasePaidRefund,
} from "./credit-source-lots.js";

const RUB = 1_000_000;
test("paid source listing is bounded before projecting administration data", async () => {
  let query = "";
  const sql: Sql = {
    exec: async () => {},
    query: async (statement) => {
      query = statement;
      return { rows: [] };
    },
  };
  assert.deepEqual(await listPaidSourceLots(sql, "1"), []);
  assert.match(query, /kind='paid'.*limit 101/s);
});
async function sourceFixture(db?: Database) {
  db ??= await connectDatabase("pglite://:memory:");
  await migrate(db);
  const repo = new Repository(db);
  const user = await repo.register("lots@example.test", "synthetic"),
    other = await repo.register("other@example.test", "synthetic");
  const ledger = new AiCreditLedger(db, "routerai_citygo_10x");
  const topup = async (amountKopeks: number, userId = user) => {
    const id = randomUUID();
    await ledger.topUpConfirmed(userId, id, {
      providerPaymentId: randomUUID(),
      merchantId: "synthetic-shop",
      test: false,
      paidKopeks: amountKopeks,
      verifiedAt: "2026-10-18T00:00:00.000Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    return id;
  };
  return { db, user, other, ledger, topup };
}
// Same lock order as the server journal; helpers deliberately open no tx.
async function sourceTransaction<T>(
  db: Database,
  userId: string,
  work: (tx: Sql) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.query(
      "select id from account_security_state where id=1 for update",
    );
    await tx.query("select id from users where id=$1 for update", [userId]);
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [userId],
    );
    return work(tx);
  });
}
async function conservation(db: Database, user: string) {
  const a = (
    await db.query<{ granted: string; held: string; spent: string }>(
      "select granted_micros::text as granted,held_micros::text as held,spent_micros::text as spent from ai_credit_accounts where user_id=$1",
      [user],
    )
  ).rows[0]!;
  const sums = (
    await db.query<{
      gross: string;
      held: string;
      spent: string;
      refunds: string;
      refunded: string;
    }>(
      "select coalesce(sum(gross_micros),0)::text as gross,coalesce(sum(held_micros),0)::text as held,coalesce(sum(spent_micros),0)::text as spent,coalesce(sum(refund_reserved_micros),0)::text as refunds,coalesce(sum(refunded_micros),0)::text as refunded from credit_source_lots where user_id=$1",
      [user],
    )
  ).rows[0]!;
  assert.equal(Number(a.granted), Number(sums.gross) - Number(sums.refunded));
  assert.equal(Number(a.held), Number(sums.held) + Number(sums.refunds));
  assert.equal(Number(a.spent), Number(sums.spent));
  for (const lot of await listPaidSourceLots(db, user))
    assert.equal(
      lot.availableMicros +
        lot.spentMicros +
        lot.heldMicros +
        lot.refundReservedMicros +
        lot.refundedMicros,
      lot.grossMicros,
    );
}

test("gift-first allocations pin paid FIFO and exact AI settlement releases unused sources", async (t) => {
  const f = await sourceFixture();
  t.after(() => f.db.close());
  await f.ledger.grantWelcome(f.user, f.other);
  const first = await f.topup(10000),
    second = await f.topup(10000);
  const hold = randomUUID();
  await f.ledger.hold(f.user, hold, 650 * RUB);
  const allocations = (
    await f.db.query<{
      kind: string;
      paid_operation_id: string;
      reserved_micros: string;
      ordinal: number;
    }>(
      "select l.kind,l.paid_operation_id,a.reserved_micros::text,a.ordinal from credit_hold_allocations a join credit_source_lots l on l.id=a.source_lot_id where a.hold_id=$1 order by a.ordinal",
      [hold],
    )
  ).rows;
  assert.deepEqual(
    allocations.map((a) => [a.kind, a.reserved_micros]),
    [
      ["gift", String(500 * RUB)],
      ["paid", String(100 * RUB)],
      ["paid", String(50 * RUB)],
    ],
  );
  assert.equal(allocations[1]!.paid_operation_id, first);
  assert.equal(allocations[2]!.paid_operation_id, second);
  await f.ledger.hold(f.user, hold, 650 * RUB);
  await conservation(f.db, f.user);
  const settled = randomUUID();
  await f.ledger.resolve(f.user, settled, hold, {
    kind: "settle",
    amountMicros: 520 * RUB + 123,
  });
  await f.ledger.resolve(f.user, settled, hold, {
    kind: "settle",
    amountMicros: 520 * RUB + 123,
  });
  const lots = await listPaidSourceLots(f.db, f.user);
  assert.equal(lots[0]!.spentMicros, 20 * RUB + 123);
  assert.equal(lots[1]!.spentMicros, 0);
  assert.equal(lots[0]!.heldMicros, 0);
  assert.equal(lots[1]!.heldMicros, 0);
  await conservation(f.db, f.user);
  const release = randomUUID();
  await f.ledger.hold(f.user, release, 10 * RUB);
  await f.ledger.resolve(f.user, randomUUID(), release, {
    kind: "release",
    amountMicros: 0,
  });
  await conservation(f.db, f.user);
});

test("only free paid money is refundable, reservations cannot be spent, terminal replay changes nothing", async (t) => {
  const f = await sourceFixture();
  t.after(() => f.db.close());
  await f.ledger.grantWelcome(f.user, f.other);
  const source = await f.topup(10000);
  const refund = randomUUID();
  const reserve = () =>
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, refund, 10000),
    );
  const r = await reserve();
  assert.equal(r.state, "reserved");
  assert.equal(r.refundedBeforeKopeks, 0);
  assert.deepEqual(await reserve(), r);
  const status = await f.ledger.status(f.user);
  assert.equal(status.availableMicros, 500 * RUB);
  assert.equal(status.heldMicros, 100 * RUB);
  await assert.rejects(f.ledger.hold(f.user, randomUUID(), 501 * RUB));
  const hold = randomUUID();
  await f.ledger.hold(f.user, hold, 100 * RUB);
  await conservation(f.db, f.user);
  const settled = await sourceTransaction(f.db, f.user, (tx) =>
    settlePaidRefund(tx, f.user, refund),
  );
  assert.equal(settled.state, "settled");
  assert.deepEqual(await reserve(), settled);
  assert.deepEqual(
    await sourceTransaction(f.db, f.user, (tx) =>
      settlePaidRefund(tx, f.user, refund),
    ),
    settled,
  );
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      releasePaidRefund(tx, f.user, refund),
    ),
  );
  await f.ledger.resolve(f.user, randomUUID(), hold, {
    kind: "settle",
    amountMicros: 50 * RUB,
  });
  const final = await f.ledger.status(f.user);
  assert.equal(final.grantedMicros, 500 * RUB);
  assert.equal(final.spentMicros, 50 * RUB);
  assert.equal(final.availableMicros, 450 * RUB);
  await conservation(f.db, f.user);
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, randomUUID(), 1),
    ),
  );
  const bonus = (
    await f.db.query<{ operation_id: string }>(
      "select operation_id from ai_credit_entries where user_id=$1 and kind='bonus'",
      [f.user],
    )
  ).rows[0]!.operation_id;
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, bonus, randomUUID(), 1),
    ),
  );
});

test("partial refunds preserve micro-dust, frozen provider baseline and release resolves even under review", async (t) => {
  const f = await sourceFixture();
  t.after(() => f.db.close());
  const source = await f.topup(100);
  const hold = randomUUID();
  await f.ledger.hold(f.user, hold, RUB);
  await f.ledger.resolve(f.user, randomUUID(), hold, {
    kind: "settle",
    amountMicros: 1,
  });
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, randomUUID(), 100),
    ),
  );
  const first = randomUUID();
  await sourceTransaction(f.db, f.user, (tx) =>
    reservePaidRefund(tx, f.user, source, first, 30),
  );
  await sourceTransaction(f.db, f.user, (tx) =>
    settlePaidRefund(tx, f.user, first),
  );
  const second = randomUUID(),
    r = await sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, second, 69),
    );
  assert.equal(r.refundedBeforeKopeks, 30);
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, randomUUID(), 1),
    ),
  );
  await f.db.query(
    "update ai_credit_accounts set billing_review_required=true where user_id=$1",
    [f.user],
  );
  await assert.rejects(f.ledger.hold(f.user, randomUUID(), 1));
  await sourceTransaction(f.db, f.user, (tx) =>
    releasePaidRefund(tx, f.user, second),
  );
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, randomUUID(), 1),
    ),
  );
  const lot = (await listPaidSourceLots(f.db, f.user))[0]!;
  assert.equal(lot.availableMicros, 699999);
  assert.equal(lot.refundedMicros, 300000);
  await conservation(f.db, f.user);
});

test("refund identity/ownership, source immutability and allocation provenance cannot be substituted", async (t) => {
  const f = await sourceFixture();
  t.after(() => f.db.close());
  const source = await f.topup(100),
    other = await f.topup(100, f.other),
    refund = randomUUID();
  await sourceTransaction(f.db, f.user, (tx) =>
    reservePaidRefund(tx, f.user, source, refund, 50),
  );
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, source, refund, 51),
    ),
  );
  await assert.rejects(
    sourceTransaction(f.db, f.other, (tx) =>
      reservePaidRefund(tx, f.other, other, refund, 50),
    ),
  );
  await assert.rejects(
    sourceTransaction(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, other, randomUUID(), 1),
    ),
  );
  for (const sql of [
    "update credit_source_lots set gross_micros=gross_micros+1",
    "update credit_source_lots set merchant_id='another-shop'",
    "update credit_refund_allocations set amount_micros=10000",
    "update credit_refund_allocations set refunded_before_kopeks=1",
  ]) {
    await assert.rejects(f.db.exec(sql));
  }
  await f.ledger.grantWelcome(f.user, f.other);
  const gift = (
    await f.db.query<{ id: string }>(
      "select id from credit_source_lots where kind='gift'",
    )
  ).rows[0]!.id;
  await assert.rejects(
    f.db.query(
      "insert into credit_refund_allocations(refund_id,user_id,source_lot_id,amount_micros,refunded_before_kopeks) values($1,$2,$3,10000,0)",
      [randomUUID(), f.user, gift],
    ),
  );
  const hold = randomUUID();
  await f.ledger.hold(f.other, hold, 10000);
  await assert.rejects(
    f.db.query(
      "insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros) values($1,$2,1,10000)",
      [hold, gift],
    ),
  );
  await conservation(f.db, f.user);
  await conservation(f.db, f.other);
});

test("source failure rolls back ledger admission and a refund transaction rolls back all counters", async (t) => {
  const f = await sourceFixture();
  t.after(() => f.db.close());
  const source = await f.topup(100);
  const before = await f.ledger.status(f.user),
    id = randomUUID();
  await assert.rejects(
    sourceTransaction(f.db, f.user, async (tx) => {
      await reservePaidRefund(tx, f.user, source, id, 50);
      throw new Error("synthetic rollback");
    }),
  );
  assert.deepEqual(await f.ledger.status(f.user), before);
  assert.equal(
    (await f.db.query("select * from credit_refund_allocations")).rows.length,
    0,
  );
  await f.db.query(
    "update ai_credit_accounts set billing_review_required=true where user_id=$1",
    [f.user],
  );
  const hold = randomUUID();
  await assert.rejects(f.ledger.hold(f.user, hold, 1));
  assert.equal(
    (
      await f.db.query(
        "select * from ai_credit_entries where operation_id=$1",
        [hold],
      )
    ).rows.length,
    0,
  );
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
  await conservation(f.db, f.user);
});

test("test payment sources preserve quarantine and never become real AI money", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  await migrate(db);
  const user = await new Repository(db).register(
      "sandbox@example.test",
      "synthetic",
    ),
    ledger = new AiCreditLedger(db),
    source = randomUUID();
  await ledger.topUpConfirmed(user, source, {
    providerPaymentId: randomUUID(),
    merchantId: "synthetic-shop",
    test: true,
    paidKopeks: 100,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  assert.equal((await listPaidSourceLots(db, user))[0]!.test, true);
  await assert.rejects(ledger.hold(user, randomUUID(), 1));
  const r = await sourceTransaction(db, user, (tx) =>
    reservePaidRefund(tx, user, source, randomUUID(), 10),
  );
  assert.equal(r.test, true);
  assert.equal(
    (await db.query("select * from npd_receipt_tasks")).rows.length,
    0,
  );
  await conservation(db, user);
});

test("migration snapshots old funds as nonrefundable, pins known old holds and preserves original postings", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n < "0017_")
    .sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  const repo = new Repository(db),
    user = await repo.register("legacy@example.test", "synthetic"),
    other = await repo.register("drift@example.test", "synthetic"),
    oldPaid = await repo.register("legacy-paid@example.test", "synthetic"),
    ledger = new AiCreditLedger(db);
  // Seed the actual pre-0017 shape, not today's ledger/status implementation
  // against a schema that does not yet contain source/debt accounting.
  await db.query(
    "insert into ai_credit_accounts(user_id,granted_micros) values($1,500000000),($2,500000000),($3,100000000)",
    [user, other, oldPaid],
  );
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id) values($1,$2,'bonus',500000000,$3),($3,$4,'bonus',500000000,$1)",
    [user, randomUUID(), other, randomUUID()],
  );
  const oldPayment = randomUUID();
  const oldProof = {
    providerPaymentId: randomUUID(),
    merchantId: "synthetic-shop",
    test: false,
    paidKopeks: 10000,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  };
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values($1,$2,'topup',100000000)",
    [oldPaid, oldPayment],
  );
  await db.query(
    `insert into ai_credit_topups(provider_payment_id,operation_id,user_id,paid_kopeks,credited_micros,merchant_id,test,verified_at,verification_receipt)
     values($1,$2,$3,10000,100000000,$4,false,$5,$6)`,
    [
      oldProof.providerPaymentId,
      oldPayment,
      oldPaid,
      oldProof.merchantId,
      oldProof.verifiedAt,
      JSON.stringify(oldProof),
    ],
  );
  // The pre-0017 ledger is seeded directly; new code must not be used before its schema.
  const hold = randomUUID();
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values($1,$2,'hold',1000000)",
    [user, hold],
  );
  await db.query(
    "update ai_credit_accounts set held_micros=1000000 where user_id=$1",
    [user],
  );
  await db.query(
    "update ai_credit_accounts set held_micros=1 where user_id=$1",
    [other],
  );
  const before = (await db.query("select * from ai_credit_entries order by id"))
    .rows;
  await db.exec(
    await readFile(new URL("0017_credit_source_lots.sql", directory), "utf8"),
  );
  assert.deepEqual(
    (await db.query("select * from ai_credit_entries order by id")).rows,
    before,
  );
  assert.equal((await listPaidSourceLots(db, user)).length, 0);
  assert.equal((await listPaidSourceLots(db, oldPaid)).length, 0);
  // Verify the 0017 backfill first, then finish the historical fixture before
  // using current runtime helpers. Production code never skips debt guards.
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith(".sql") && n > "0017_credit_source_lots.sql")
    .sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  await assert.rejects(
    sourceTransaction(db, oldPaid, (tx) =>
      reservePaidRefund(tx, oldPaid, oldPayment, randomUUID(), 100),
    ),
  );
  await ledger.grantWelcome(oldPaid, user);
  const newPayment = randomUUID();
  await ledger.topUpConfirmed(oldPaid, newPayment, {
    providerPaymentId: randomUUID(),
    merchantId: "synthetic-shop",
    test: false,
    paidKopeks: 10000,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const mixedHold = randomUUID();
  await ledger.hold(oldPaid, mixedHold, 650 * RUB);
  assert.deepEqual(
    (
      await db.query<{ kind: string; reserved_micros: string }>(
        "select l.kind,a.reserved_micros::text from credit_hold_allocations a join credit_source_lots l on l.id=a.source_lot_id where hold_id=$1 order by ordinal",
        [mixedHold],
      )
    ).rows.map((row) => [row.kind, row.reserved_micros]),
    [
      ["gift", String(500 * RUB)],
      ["legacy_nonrefundable", String(100 * RUB)],
      ["paid", String(50 * RUB)],
    ],
  );
  await ledger.resolve(oldPaid, randomUUID(), mixedHold, {
    kind: "release",
    amountMicros: 0,
  });
  await conservation(db, oldPaid);
  assert.equal(
    (
      await db.query<{ kind: string }>(
        "select kind from credit_source_lots where user_id=$1",
        [user],
      )
    ).rows[0]!.kind,
    "legacy_nonrefundable",
  );
  assert.equal(
    (
      await db.query("select * from credit_hold_allocations where hold_id=$1", [
        hold,
      ])
    ).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query<{ billing_review_required: boolean }>(
        "select billing_review_required from ai_credit_accounts where user_id=$1",
        [other],
      )
    ).rows[0]!.billing_review_required,
    true,
  );
  await ledger.resolve(user, randomUUID(), hold, {
    kind: "settle",
    amountMicros: 123,
  });
  await conservation(db, user);
  await assert.rejects(ledger.hold(other, randomUUID(), 1));
  await assert.rejects(
    sourceTransaction(db, user, (tx) =>
      reservePaidRefund(tx, user, randomUUID(), randomUUID(), 1),
    ),
  );
  await db.query(
    "update ai_credit_accounts set billing_review_required=true where user_id=$1",
    [user],
  );
  // Previously confirmed legacy reservations remain resolvable despite review.
  const oldhold = randomUUID(); // no allocation means the old unknown hold must fail closed.
  await db.query(
    "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values($1,$2,'hold',1)",
    [user, oldhold],
  );
  await assert.rejects(
    ledger.resolve(user, randomUUID(), oldhold, {
      kind: "release",
      amountMicros: 0,
    }),
  );
});

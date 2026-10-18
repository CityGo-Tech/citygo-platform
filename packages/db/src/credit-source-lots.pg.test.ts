import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
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
} from "./credit-source-lots.js";

const RUB = 1_000_000;
const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in localhost disposable PostgreSQL; PGlite is not race evidence",
  timeout: 60_000,
};
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic source-lots barrier timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waiting(db: Sql) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      (
        await db.query(
          "select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'",
        )
      ).rows.length
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic source-lots lock wait was not observed");
}
function paused(db: Database, match: string) {
  const entered = signal(),
    release = signal();
  let held = false;
  const wrapper: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (!held && sql.includes(match)) {
              held = true;
              entered.open();
              await release.promise;
            }
            return result;
          },
        }),
      ),
  };
  return { db: wrapper, entered, release };
}
async function locked<T>(
  db: Database,
  user: string,
  work: (tx: Sql) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.query(
      "select id from account_security_state where id=1 for update",
    );
    await tx.query("select id from users where id=$1 for update", [user]);
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [user],
    );
    return work(tx);
  });
}
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(["5432", "55438"].includes(url.port || "5432"));
  assert.ok(["/citygo_test", "/citygo_synthetic"].includes(url.pathname));
  assert.equal(url.search, "");
  const name = "cg_source_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_source_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await admin.query(`drop database "${name}"`);
    } finally {
      await admin.close();
    }
  });
  await admin.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  const user = await new Repository(db).register(
      "source-race@example.test",
      "synthetic",
    ),
    ledger = new AiCreditLedger(db),
    source = randomUUID();
  await ledger.topUpConfirmed(user, source, {
    providerPaymentId: randomUUID(),
    merchantId: "synthetic-shop",
    test: false,
    paidKopeks: 10000,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  return { db, user, ledger, source };
}

test(
  "PostgreSQL AI hold and refund reservation serialize without spending refundable money twice",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      pause = paused(
        f.db,
        "select user_id from ai_credit_accounts where user_id=$1 for update",
      ),
      hold = randomUUID();
    const winner = new AiCreditLedger(pause.db).hold(f.user, hold, 50 * RUB);
    await within(pause.entered.promise);
    const loser = locked(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, f.source, randomUUID(), 10000),
    );
    const outcome = loser.then(
      () => "unexpected-success",
      () => "rejected",
    );
    try {
      await waiting(f.db);
    } finally {
      pause.release.open();
    }
    await within(winner);
    assert.equal(await within(outcome), "rejected");
    const lot = (await listPaidSourceLots(f.db, f.user))[0]!;
    assert.equal(lot.heldMicros, 50 * RUB);
    assert.equal(lot.refundReservedMicros, 0);
    assert.equal(lot.availableMicros, 50 * RUB);
  },
);

test(
  "PostgreSQL two refund actors reserve one source once and terminal replay preserves net granted",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      pause = paused(
        f.db,
        "select user_id from ai_credit_accounts where user_id=$1 for update",
      ),
      refund = randomUUID();
    const winner = locked(pause.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, f.source, refund, 6000),
    );
    await within(pause.entered.promise);
    const loser = locked(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, f.source, randomUUID(), 4000),
    );
    const outcome = loser.then(
      () => "unexpected-success",
      () => "rejected",
    );
    try {
      await waiting(f.db);
    } finally {
      pause.release.open();
    }
    await within(winner);
    assert.equal(await within(outcome), "rejected");
    await locked(f.db, f.user, (tx) => settlePaidRefund(tx, f.user, refund));
    await locked(f.db, f.user, (tx) => settlePaidRefund(tx, f.user, refund));
    const status = await f.ledger.status(f.user);
    assert.equal(status.grantedMicros, 40 * RUB);
    assert.equal(status.heldMicros, 0);
    assert.equal(status.spentMicros, 0);
    const lot = (await listPaidSourceLots(f.db, f.user))[0]!;
    assert.equal(lot.refundedMicros, 60 * RUB);
    assert.equal(lot.availableMicros, 40 * RUB);
    assert.equal(
      (await f.db.query("select * from credit_refund_allocations")).rows.length,
      1,
    );
  },
);

test(
  "PostgreSQL refund waits for AI actual settlement and can reserve only the released paid remainder",
  pgOnly,
  async (t) => {
    const f = await fixture(t),
      hold = randomUUID();
    await f.ledger.hold(f.user, hold, 100 * RUB);
    const pause = paused(
      f.db,
      "select user_id from ai_credit_accounts where user_id=$1 for update",
    );
    const winner = new AiCreditLedger(pause.db).resolve(
      f.user,
      randomUUID(),
      hold,
      { kind: "settle", amountMicros: RUB },
    );
    await within(pause.entered.promise);
    const next = locked(f.db, f.user, (tx) =>
      reservePaidRefund(tx, f.user, f.source, randomUUID(), 9900),
    );
    try {
      await waiting(f.db);
    } finally {
      pause.release.open();
    }
    await within(winner);
    const allocation = await within(next);
    assert.equal(allocation.amountKopeks, 9900);
    const lot = (await listPaidSourceLots(f.db, f.user))[0]!;
    assert.equal(lot.spentMicros, RUB);
    assert.equal(lot.heldMicros, 0);
    assert.equal(lot.refundReservedMicros, 99 * RUB);
    assert.equal(lot.availableMicros, 0);
    const status = await f.ledger.status(f.user);
    assert.equal(status.heldMicros, 99 * RUB);
    assert.equal(status.spentMicros, RUB);
    assert.equal(status.availableMicros, 0);
  },
);

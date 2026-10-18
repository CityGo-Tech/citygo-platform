import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "./index.js";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { AiCreditLedger } from "./ai-credit.js";
import { FreshAccountReset } from "./fresh-account-reset.js";
import {
  assertRealAiDatabaseSafety,
  assertTestPaymentsDatabaseSafety,
  lockPaymentMode,
} from "./payment-isolation.js";

async function fixture() {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const user = await new Repository(db).register(
    "isolation@example.test",
    "SYNTHETIC-HASH",
  );
  const orders = new PaymentTopupOrders(db),
    ledger = new AiCreditLedger(db);
  const create = () =>
    orders.create(
      user,
      randomUUID(),
      10_000,
      "synthetic-shop",
      true,
      "https://citygo.example.test/",
    );
  const state = async () =>
    (
      await db.query<{
        test_payments_seen: boolean;
        real_ai_admitted: boolean;
      }>(
        "select test_payments_seen,real_ai_admitted from account_security_state",
      )
    ).rows[0]!;
  return { db, user, orders, ledger, create, state };
}
const payment = (test: boolean) => ({
  providerPaymentId: randomUUID(),
  paidKopeks: 10_000,
  merchantId: "synthetic-shop",
  test,
  verifiedAt: "2026-10-18T00:00:00.000Z",
  verification: "server_get_succeeded" as const,
  currency: "RUB" as const,
});

test("test order quarantines the whole DB across reconstructed services and deleted order rows", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await assertRealAiDatabaseSafety(f.db);
  await assertTestPaymentsDatabaseSafety(f.db);
  const order = await f.create();
  assert.deepEqual(await f.state(), {
    test_payments_seen: true,
    real_ai_admitted: false,
  });
  await assert.rejects(assertRealAiDatabaseSafety(f.db));
  await assert.rejects(new AiCreditLedger(f.db).hold(f.user, randomUUID(), 1));
  await f.db.query("delete from payment_topup_orders where id=$1", [order.id]);
  await assert.rejects(assertRealAiDatabaseSafety(f.db));
  await assert.rejects(
    f.db.query(
      "update account_security_state set test_payments_seen=false where id=1",
    ),
  );
  assert.deepEqual(await f.state(), {
    test_payments_seen: true,
    real_ai_admitted: false,
  });
});

test("confirmed sandbox credit is never a spendable real-AI hold after restart", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), payment(true));
  assert.equal((await f.ledger.status(f.user)).grantedMicros, 100_000_000);
  await assert.rejects(
    new AiCreditLedger(f.db).hold(f.user, randomUUID(), 1_000_000),
  );
  await assert.rejects(f.db.transaction((tx) => lockPaymentMode(tx, "real")));
  assert.equal((await f.ledger.status(f.user)).heldMicros, 0);
});

test("real admission or paid non-test receipt prevents test activation on the same DB", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.ledger.topUpConfirmed(f.user, randomUUID(), payment(false));
  await assertRealAiDatabaseSafety(f.db);
  await assert.rejects(assertTestPaymentsDatabaseSafety(f.db));
  await assert.rejects(f.create());
  await assert.rejects(
    f.ledger.topUpConfirmed(f.user, randomUUID(), payment(true)),
  );
  assert.deepEqual(await f.state(), {
    test_payments_seen: false,
    real_ai_admitted: true,
  });
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    0,
  );
});

test("failed create rolls back the sticky mode together with the order", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const broken: Database = {
    ...f.db,
    transaction: (work) =>
      f.db.transaction((tx) =>
        work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (sql.includes("insert into payment_topup_orders"))
              throw new Error("synthetic rollback");
            return result;
          },
        }),
      ),
  };
  await assert.rejects(
    new PaymentTopupOrders(broken).create(
      f.user,
      randomUUID(),
      100,
      "synthetic-shop",
      true,
      "https://citygo.example.test/",
    ),
  );
  assert.deepEqual(await f.state(), {
    test_payments_seen: false,
    real_ai_admitted: false,
  });
});

test("only the explicit empty closed reset can clear quarantine before its new bootstrap", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.create();
  const reset = new FreshAccountReset(f.db);
  const plan = await reset.plan({
    expectedUserCount: 1,
    maintenanceConfirmed: true,
  });
  assert.deepEqual(plan.blockers, []);
  await reset.apply({
    expectedUserCount: 1,
    expectedSnapshotFingerprint: plan.snapshotFingerprint,
    backupReceiptSha256: "b".repeat(64),
    maintenanceConfirmed: true,
    servicesStoppedConfirmed: true,
    destructiveResetConfirmed: true,
    passwordHash: "SYNTHETIC-NEW-HASH",
  });
  assert.deepEqual(await f.state(), {
    test_payments_seen: false,
    real_ai_admitted: false,
  });
  await assertRealAiDatabaseSafety(f.db);
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    0,
  );
});

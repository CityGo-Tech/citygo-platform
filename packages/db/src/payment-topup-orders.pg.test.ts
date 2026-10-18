import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { AiCreditLedger } from "./ai-credit.js";
import {
  lockPaymentMode,
  assertRealAiDatabaseSafety,
} from "./payment-isolation.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
  type Sql,
} from "./index.js";

// Opt-in disposable PostgreSQL only, never an application .env or payment API.
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !/^postgres(?:ql)?:\/\//.test(testUrl))
  throw new Error("Invalid synthetic PostgreSQL URL");
const returnUrl = "https://citygo.example.test/test-balance";
async function fixture() {
  const admin = await connectDatabase(testUrl!);
  const token = randomUUID().replaceAll("-", "");
  const schema = "checkout_" + token,
    role = "checkout_role_" + token;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(testUrl!);
  scoped.searchParams.set("options", "-c search_path=" + schema);
  const db = await connectDatabase(scoped.toString());
  await migrate(db);
  const repo = new Repository(db);
  const user = await repo.register(
    "synthetic-checkout@example.test",
    "SYNTHETIC-HASH",
  );
  const other = await repo.register(
    "synthetic-other@example.test",
    "SYNTHETIC-HASH",
  );
  await admin.query(`create role "${role}"`);
  await admin.query(`grant usage on schema "${schema}" to "${role}"`);
  await admin.query(`grant select,update on "${schema}".users to "${role}"`);
  await admin.query(
    `grant select on "${schema}".ai_credit_topups to "${role}"`,
  );
  await admin.query(
    `grant select on "${schema}".account_security_state to "${role}"`,
  );
  await admin.query(
    `grant update(test_payments_seen,real_ai_admitted) on "${schema}".account_security_state to "${role}"`,
  );
  await admin.query(
    `grant select,insert on "${schema}".payment_topup_orders to "${role}"`,
  );
  await admin.query(
    `grant update(provider_payment_id,status,confirmation_url,updated_at) on "${schema}".payment_topup_orders to "${role}"`,
  );
  const roleTransaction = <T>(work: (sql: Sql) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.query(`set local role "${role}"`);
      return work(tx);
    });
  const runtime: Database = {
    query: (sql, params) => roleTransaction((tx) => tx.query(sql, params)),
    exec: (sql) => roleTransaction((tx) => tx.exec(sql)),
    transaction: roleTransaction,
    close: async () => {},
  };
  return {
    db,
    runtime,
    user,
    other,
    orders: new PaymentTopupOrders(db),
    close: async () => {
      await db.close();
      assert.match(schema, /^checkout_[a-f0-9]{32}$/);
      assert.match(role, /^checkout_role_[a-f0-9]{32}$/);
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.query(`drop role "${role}"`);
      await admin.close();
    },
  };
}

test(
  "PostgreSQL orders: repeated requests serialize and provider identity is globally unique",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const request = randomUUID();
    const created = await Promise.all(
      Array.from({ length: 8 }, () =>
        f.orders.create(
          f.user,
          request,
          10_000,
          "synthetic-shop",
          true,
          returnUrl,
        ),
      ),
    );
    assert.equal(new Set(created.map((o) => o.id)).size, 1);
    const order = created[0]!;
    const other = await f.orders.create(
      f.other,
      randomUUID(),
      10_000,
      "synthetic-shop",
      true,
      returnUrl,
    );
    const payment = randomUUID();
    const results = await Promise.allSettled([
      f.orders.recordProvider(f.user, order.id, {
        providerPaymentId: payment,
        status: "pending",
      }),
      f.orders.recordProvider(f.other, other.id, {
        providerPaymentId: payment,
        status: "pending",
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      (
        await f.db.query(
          "select * from payment_topup_orders where provider_payment_id is not null",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select * from ai_credit_topups")).rows.length,
      0,
    );
  },
);

test(
  "PostgreSQL orders: narrow runtime role supports FOR UPDATE, cannot mutate payload or fake success",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const orders = new PaymentTopupOrders(f.runtime),
      payment = randomUUID();
    const order = await orders.create(
      f.user,
      randomUUID(),
      10_000,
      "synthetic-shop",
      true,
      returnUrl,
    );
    await orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
      confirmationUrl: "https://checkout.example.test/synthetic",
    });
    await assert.rejects(
      f.runtime.query(
        "update payment_topup_orders set create_payload='{}' where id=$1",
        [order.id],
      ),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "42501",
    );
    await assert.rejects(
      f.runtime.query(
        "update payment_topup_orders set created_at=now()-interval '2 days' where id=$1",
        [order.id],
      ),
    );
    await assert.rejects(
      f.runtime.query(
        "update payment_topup_orders set status='succeeded' where id=$1",
        [order.id],
      ),
    );
    await new AiCreditLedger(f.db).topUpConfirmed(f.user, order.id, {
      providerPaymentId: payment,
      paidKopeks: 10_000,
      merchantId: "synthetic-shop",
      test: true,
      verifiedAt: "2026-10-18T00:00:00.000Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    const completed = await orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "succeeded",
    });
    assert.equal(completed.credited, true);
    assert.equal(completed.status, "succeeded");
    await assert.rejects(
      f.runtime.query(
        "update payment_topup_orders set status='canceled' where id=$1",
        [order.id],
      ),
    );
    const invoker = (
      await f.db.query<{ prosecdef: boolean }>(
        "select prosecdef from pg_proc where proname='citygo_guard_payment_topup_order' and pronamespace=current_schema()::regnamespace",
      )
    ).rows[0]!;
    assert.equal(invoker.prosecdef, false);
  },
);

test(
  "PostgreSQL: real admission and test checkout on separate connections have exactly one mode winner",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const results = await Promise.allSettled([
      f.db.transaction((tx) => lockPaymentMode(tx, "real")),
      new PaymentTopupOrders(f.runtime).create(
        f.other,
        randomUUID(),
        100,
        "synthetic-shop",
        true,
        returnUrl,
      ),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const state = (
      await f.db.query<{
        test_payments_seen: boolean;
        real_ai_admitted: boolean;
      }>(
        "select test_payments_seen,real_ai_admitted from account_security_state",
      )
    ).rows[0]!;
    assert.notEqual(state.test_payments_seen, state.real_ai_admitted);
    if (state.test_payments_seen) {
      await assert.rejects(assertRealAiDatabaseSafety(f.db));
      await assert.rejects(
        f.runtime.query(
          "update account_security_state set test_payments_seen=false where id=1",
        ),
      );
    } else {
      await assertRealAiDatabaseSafety(f.db);
      await assert.rejects(
        f.runtime.query(
          "update account_security_state set real_ai_admitted=false where id=1",
        ),
      );
    }
  },
);

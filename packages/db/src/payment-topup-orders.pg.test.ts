import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { AiCreditLedger } from "./ai-credit.js";
import { PaymentRefunds } from "./payment-refunds.js";
import {
  lockPaymentMode,
  assertRealAiDatabaseSafety,
} from "./payment-isolation.js";
import {
  connectDatabase,
  DomainError,
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
const receiptProfile = "citygo_service_full_payment_v1" as const;
const receiptEmail = "receipt@citygo-synthetic.ru";
async function fixture() {
  const scoped = new URL(testUrl!);
  assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(scoped.hostname));
  assert.ok(["5432", "55438"].includes(scoped.port || "5432"));
  assert.ok(["/citygo_test", "/citygo_synthetic"].includes(scoped.pathname));
  assert.equal(scoped.search, "");
  assert.equal(scoped.hash, "");
  const token = randomUUID().replaceAll("-", "");
  const database = "checkout_" + token,
    role = "checkout_role_" + token;
  assert.match(database, /^checkout_[a-f0-9]{32}$/);
  assert.match(role, /^checkout_role_[a-f0-9]{32}$/);
  const resources: { admin?: Database; db?: Database } = {};
  let created = false,
    roleCreated = false,
    closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      for (const action of [
        async () => resources.db?.close(),
        async () => {
          if (created)
            await resources.admin!.query(`drop database "${database}"`);
        },
        async () => {
          if (roleCreated) await resources.admin!.query(`drop role "${role}"`);
        },
        async () => resources.admin?.close(),
      ]) {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Synthetic checkout cleanup failed");
    })());
  try {
    const admin = await connectDatabase(testUrl!);
    resources.admin = admin;
    await admin.query(`create database "${database}" template template0`);
    created = true;
    scoped.pathname = "/" + database;
    const db = await connectDatabase(scoped.toString());
    resources.db = db;
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
    roleCreated = true;
    await db.query(`grant usage on schema public to "${role}"`);
    await db.query(`grant select,update on public.users to "${role}"`);
    await db.query(`grant select on public.ai_credit_topups to "${role}"`);
    await db.query(
      `grant select on public.account_security_state to "${role}"`,
    );
    await db.query(
      `grant update(test_payments_seen,real_ai_admitted) on public.account_security_state to "${role}"`,
    );
    await db.query(
      `grant select,insert on public.payment_topup_orders to "${role}"`,
    );
    await db.query(
      `grant update(provider_payment_id,status,confirmation_url,updated_at) on public.payment_topup_orders to "${role}"`,
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
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Synthetic checkout setup and cleanup failed",
      );
    }
    throw error;
  }
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

test(
  "PostgreSQL: simultaneous live/test checkout has exactly one durable mode winner",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const orders = new PaymentTopupOrders(f.runtime);
    const results = await Promise.allSettled(
      [false, true].map((testPayment) =>
        orders.create(
          testPayment ? f.user : f.other,
          randomUUID(),
          10_000,
          "synthetic-shop",
          testPayment,
          returnUrl,
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const state = (
      await f.db.query<{
        test_payments_seen: boolean;
        real_ai_admitted: boolean;
      }>(
        "select test_payments_seen,real_ai_admitted from account_security_state where id=1",
      )
    ).rows[0]!;
    const saved = (
      await f.db.query<{ test: boolean }>(
        "select test from payment_topup_orders",
      )
    ).rows;
    assert.equal(saved.length, 1);
    assert.equal(state.test_payments_seen, saved[0]!.test);
    assert.equal(state.real_ai_admitted, !saved[0]!.test);
  },
);

test(
  "PostgreSQL: live checkout works under unchanged narrow role and matching live credit creates one receipt and source",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const orders = new PaymentTopupOrders(f.runtime);
    const request = randomUUID();
    const order = await orders.create(
      f.user,
      request,
      10_000,
      "synthetic-shop",
      false,
      returnUrl,
    );
    assert.equal(order.test, false);
    assert.equal(order.createPayload.description, "Пополнение баланса CityGo");
    assert.deepEqual(
      await orders.create(
        f.user,
        request,
        10_000,
        "synthetic-shop",
        false,
        returnUrl,
      ),
      order,
    );
    const payment = randomUUID();
    const ledger = new AiCreditLedger(f.db);
    const proof = {
      providerPaymentId: payment,
      paidKopeks: 10_000,
      merchantId: "synthetic-shop",
      test: false,
      verifiedAt: "2026-10-18T00:00:00.000Z",
      verification: "server_get_succeeded" as const,
      currency: "RUB" as const,
    };
    await orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
    });
    await assert.rejects(
      orders.recordProvider(f.user, order.id, {
        providerPaymentId: payment,
        status: "succeeded",
      }),
    );
    await ledger.topUpConfirmed(f.user, order.id, proof);
    await ledger.topUpConfirmed(f.user, order.id, proof);
    const result = await orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "succeeded",
    });
    assert.equal(result.credited, true);
    assert.equal((await ledger.status(f.user)).availableMicros, 100_000_000);
    assert.equal(
      (await f.db.query("select 1 from ai_credit_topups where not test")).rows
        .length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from credit_source_lots where kind='paid' and not test",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "select 1 from npd_receipt_tasks where registration_status='pending' and delivery_status='pending'",
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      f.runtime.query("update payment_topup_orders set test=true where id=$1", [
        order.id,
      ]),
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "42501",
    );
    await assert.rejects(
      f.db.query("update payment_topup_orders set test=true where id=$1", [
        order.id,
      ]),
      /Payment order identity is immutable/,
    );
    const isolation = (
      await f.db.query<{ prosecdef: boolean }>(
        "select prosecdef from pg_proc where proname='citygo_mark_payment_isolation' and pronamespace=current_schema()::regnamespace",
      )
    ).rows[0]!;
    assert.equal(isolation.prosecdef, false);
    await assert.rejects(
      orders.create(
        f.other,
        randomUUID(),
        10_000,
        "synthetic-shop",
        true,
        returnUrl,
      ),
    );
  },
);

test(
  "PostgreSQL receipt snapshots: concurrent same request has one immutable body and conflicting emails never dispatch",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const orders = new PaymentTopupOrders(f.runtime),
      request = randomUUID();
    const create = (email = receiptEmail) =>
      orders.create(
        f.user,
        request,
        10000,
        "synthetic-shop",
        false,
        returnUrl,
        { receiptEmail: email, receiptProfile },
      );
    const same = await Promise.all(Array.from({ length: 6 }, () => create()));
    assert.equal(new Set(same.map((o) => o.id)).size, 1);
    const first = same[0]!;
    assert.equal(first.payloadVersion, 2);
    assert.equal(first.receiptEmail, receiptEmail);
    assert.deepEqual(await orders.getByRequestId(f.user, request), first);
    await assert.rejects(
      orders.getByRequestId(f.other, request),
      (e: unknown) => e instanceof DomainError && e.statusCode === 404,
    );
    const collision = await Promise.allSettled(
      Array.from({ length: 3 }, () => create("different@citygo-synthetic.ru")),
    );
    assert.equal(
      collision.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof DomainError &&
          r.reason.statusCode === 409,
      ).length,
      3,
    );
    await assert.rejects(
      f.db.query(
        "update payment_topup_orders set receipt_email='different@citygo-synthetic.ru' where id=$1",
        [first.id],
      ),
      /snapshot is immutable/,
    );
    await assert.rejects(
      f.db.query(
        "update payment_topup_orders set payload_version=1 where id=$1",
        [first.id],
      ),
      /snapshot is immutable/,
    );
    await assert.rejects(
      f.runtime.query(
        "update payment_topup_orders set receipt_profile='different' where id=$1",
        [first.id],
      ),
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        e.code === "42501",
    );
    const payload = structuredClone(first.createPayload),
      id = randomUUID();
    payload.metadata.citygo_order_id = id;
    payload.receipt!.items[0]!.amount.value = "99.99";
    await assert.rejects(
      f.runtime.query(
        `insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload,
      payload_version,receipt_email,receipt_profile) values($1,$2,$3,10000,'synthetic-shop',false,$4,$5,2,$6,$7)`,
        [
          id,
          f.user,
          randomUUID(),
          returnUrl,
          JSON.stringify(payload),
          receiptEmail,
          receiptProfile,
        ],
      ),
    );
    assert.equal(
      (
        await f.db.query(
          "select count(*)::integer as n from payment_topup_orders",
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (await f.db.query("select count(*)::integer as n from ai_credit_topups"))
        .rows[0]!.n,
      0,
    );
    assert.deepEqual(
      (await orders.get(f.user, first.id)).createPayload,
      first.createPayload,
    );
  },
);

test(
  "PostgreSQL receipt snapshots: NPD and repeated partial/full refunds retain original payer email and exact dispatch bodies",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    await f.db.query("update users set role='super_admin' where id=$1", [
      f.other,
    ]);
    const ctx = { userId: f.other, sessionTokenHash: "b".repeat(64) };
    await f.db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [ctx.sessionTokenHash, f.other],
    );
    const ledger = new AiCreditLedger(f.db),
      refunds = new PaymentRefunds(f.db);
    const paid = async () => {
      const order = await f.orders.create(
          f.user,
          randomUUID(),
          10000,
          "synthetic-shop",
          false,
          returnUrl,
          { receiptEmail, receiptProfile },
        ),
        payment = randomUUID();
      await f.orders.recordProvider(f.user, order.id, {
        providerPaymentId: payment,
        status: "pending",
      });
      await f.db.query(
        "update user_credentials set email='changed@citygo-synthetic.ru' where user_id=$1",
        [f.user],
      );
      await ledger.topUpConfirmed(f.user, order.id, {
        providerPaymentId: payment,
        paidKopeks: 10000,
        merchantId: "synthetic-shop",
        test: false,
        verifiedAt: new Date().toISOString(),
        verification: "server_get_succeeded",
        currency: "RUB",
      });
      assert.equal(
        (
          await f.db.query<{ buyer_email: string }>(
            "select buyer_email from npd_receipt_tasks where id=$1",
            [order.id],
          )
        ).rows[0]!.buyer_email,
        receiptEmail,
      );
      return order;
    };
    const original = await paid(),
      command = {
        requestId: randomUUID(),
        paymentOperationId: original.id,
        amountKopeks: 2500,
      };
    const repeated = await Promise.all(
      Array.from({ length: 4 }, () => refunds.create(ctx, command)),
    );
    assert.equal(new Set(repeated.map((r) => r.refund.id)).size, 1);
    assert.equal((await ledger.status(f.user)).heldMicros, 25_000_000);
    const partial = repeated[0]!.refund;
    const dispatch = await refunds.prepareDispatch(ctx, partial.id, {
      merchantId: "synthetic-shop",
      test: false,
    });
    const expected = structuredClone(original.createPayload.receipt!);
    expected.items[0]!.amount.value = "25.00";
    assert.deepEqual(dispatch.dispatch!.input.receipt, expected);
    assert.deepEqual(
      (dispatch.dispatch!.input.createPayload as { receipt: unknown }).receipt,
      expected,
    );
    await assert.rejects(
      f.db.query(
        "update payment_refunds set receipt_email='other@citygo-synthetic.ru',revision=revision+1 where id=$1",
        [partial.id],
      ),
      /snapshot is immutable/,
    );
    await assert.rejects(
      f.db.query(
        "update payment_refunds set create_payload=create_payload-'receipt' where id=$1",
        [partial.id],
      ),
    );
    const fullOriginal = await paid();
    const full = await refunds.create(ctx, {
      requestId: randomUUID(),
      paymentOperationId: fullOriginal.id,
      amountKopeks: 10000,
    });
    const fullDispatch = await refunds.prepareDispatch(ctx, full.refund.id, {
      merchantId: "synthetic-shop",
      test: false,
    });
    assert.equal(fullDispatch.dispatch!.input.receipt, undefined);
    assert.equal(
      "receipt" in (fullDispatch.dispatch!.input.createPayload as object),
      false,
    );
    const rows = (
      await f.db.query<{ payload_version: number; receipt_email: string }>(
        "select payload_version,receipt_email from payment_refunds",
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every(
        (r) => r.payload_version === 2 && r.receipt_email === receiptEmail,
      ),
    );
  },
);

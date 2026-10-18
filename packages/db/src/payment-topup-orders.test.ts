import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PaymentTopupOrders } from "./payment-topup-orders.js";
import { AiCreditLedger } from "./ai-credit.js";
import { assertRealAiDatabaseSafety } from "./payment-isolation.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "./index.js";

const returnUrl = "https://citygo.example.test/balance";
const confirmationUrl = "https://checkout.example.test/synthetic-payment";
async function fixture(testPayment = true) {
  const db = await connectDatabase("pglite://:memory:");
  await migrate(db);
  const repo = new Repository(db);
  const user = await repo.register("checkout@example.test", "SYNTHETIC-HASH");
  const other = await repo.register("other@example.test", "SYNTHETIC-HASH");
  const orders = new PaymentTopupOrders(db);
  const create = (amount = 10_000, request = randomUUID()) =>
    orders.create(
      user,
      request,
      amount,
      "synthetic-shop",
      testPayment,
      returnUrl,
    );
  const credit = async (
    orderId: string,
    paymentId: string,
    amountKopeks = 10_000,
    merchantId = "synthetic-shop",
  ) => {
    return new AiCreditLedger(db).topUpConfirmed(user, orderId, {
      providerPaymentId: paymentId,
      paidKopeks: amountKopeks,
      merchantId,
      test: testPayment,
      verifiedAt: "2026-10-18T00:00:00.000Z",
      verification: "server_get_succeeded",
      currency: "RUB",
    });
  };
  return { db, user, other, orders, create, credit };
}

test("checkout create persists deterministic exact provider payload and DB time", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const order = await f.create(10_123);
  assert.equal(order.status, "queued");
  assert.equal(order.credited, false);
  assert.equal(order.createKey, order.id);
  assert.equal(order.userId, f.user);
  assert.equal(order.currency, "RUB");
  assert.equal(order.test, true);
  assert.equal(order.amountKopeks, 10_123);
  assert.equal(order.providerPaymentId, null);
  assert.equal(order.confirmationUrl, null);
  assert.deepEqual(order.createPayload, {
    amount: { value: "101.23", currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    metadata: { citygo_order_id: order.id },
    description: "Пополнение тестового баланса CityGo",
  });
  const stored = (
    await f.db.query<{ at: string }>(
      "select to_char(created_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as at from payment_topup_orders where id=$1",
      [order.id],
    )
  ).rows[0]!;
  assert.equal(order.createdAt, stored.at);
  assert.ok(Number.isFinite(Date.parse(order.createdAt)));
  assert.equal(
    (await new AiCreditLedger(f.db).status(f.user)).grantedMicros,
    0,
  );
});

test("request replay returns same immutable order, rejects changed amount, shop, mode and URL", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const request = randomUUID(),
    order = await f.create(10_000, request);
  assert.deepEqual(await f.create(10_000, request), order);
  await assert.rejects(f.create(10_001, request));
  await assert.rejects(
    f.orders.create(f.user, request, 10_000, "other-shop", true, returnUrl),
  );
  await assert.rejects(
    f.orders.create(
      f.user,
      request,
      10_000,
      "synthetic-shop",
      false,
      returnUrl,
    ),
  );
  await assert.rejects(
    f.orders.create(
      f.user,
      request,
      10_000,
      "synthetic-shop",
      true,
      returnUrl + "/other",
    ),
  );
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    1,
  );
  assert.deepEqual(await f.orders.get(f.user, order.id), order);
});

test("checkout ownership hides foreign orders and account-scopes request UUID", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const request = randomUUID(),
    order = await f.create(10_000, request);
  await assert.rejects(
    f.orders.get(f.other, order.id),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404,
  );
  await assert.rejects(
    f.orders.recordProvider(f.other, order.id, {
      providerPaymentId: randomUUID(),
      status: "pending",
    }),
  );
  await assert.rejects(f.orders.markReviewRequired(f.other, order.id));
  const second = await f.orders.create(
    f.other,
    request,
    10_000,
    "synthetic-shop",
    true,
    returnUrl,
  );
  assert.notEqual(second.id, order.id);
});

test("checkout rejects malformed amounts, identities and redirect destinations before mutation", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  for (const amount of [0, 99, 100.5, 1_000_001, NaN, Infinity])
    await assert.rejects(f.create(amount));
  for (const destination of [
    "not-a-url",
    "https://user:secret@example.test/",
    "http://remote.example.test/",
    "javascript:alert(1)",
  ])
    await assert.rejects(
      f.orders.create(
        f.user,
        randomUUID(),
        100,
        "synthetic-shop",
        true,
        destination,
      ),
    );
  await assert.rejects(
    f.orders.create(f.user, "not-uuid", 100, "synthetic-shop", true, returnUrl),
  );
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    0,
  );
  assert.equal(
    (
      await f.orders.create(
        f.user,
        randomUUID(),
        100,
        "synthetic-shop",
        true,
        "http://localhost:3000/balance",
      )
    ).amountKopeks,
    100,
  );
});

test("provider identity, checkout link and global payment association cannot be replaced", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const order = await f.create(),
    payment = randomUUID();
  const pending = await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
    confirmationUrl,
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.credited, false);
  const replay = await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
  });
  assert.equal(replay.confirmationUrl, confirmationUrl);
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: randomUUID(),
      status: "pending",
    }),
  );
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
      confirmationUrl: confirmationUrl + "-different",
    }),
  );
  const second = await f.create();
  await assert.rejects(
    f.orders.recordProvider(f.user, second.id, {
      providerPaymentId: payment,
      status: "pending",
    }),
  );
  assert.equal((await f.orders.get(f.user, second.id)).status, "queued");
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
      confirmationUrl: "http://untrusted.example.test/",
    }),
  );
});

test("provider succeeded cannot precede actual matching posting", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const order = await f.create(),
    payment = randomUUID();
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "succeeded",
    }),
  );
  assert.equal((await f.orders.get(f.user, order.id)).providerPaymentId, null);
  const unrelated = await f.create();
  await f.credit(unrelated.id, payment);
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "succeeded",
    }),
  );
  assert.equal((await f.orders.get(f.user, order.id)).credited, false);
});

test("credited is derived from exact receipt, then terminal success is monotonic", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const order = await f.create(),
    payment = randomUUID();
  await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
    confirmationUrl,
  });
  await f.credit(order.id, payment);
  const before = await f.orders.get(f.user, order.id);
  assert.equal(before.status, "pending");
  assert.equal(before.credited, true);
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "canceled",
    }),
  );
  const result = await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "succeeded",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.credited, true);
  await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "succeeded",
  });
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
    }),
  );
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "canceled",
    }),
  );
  assert.equal(
    (await f.orders.markReviewRequired(f.user, order.id)).status,
    "succeeded",
  );
  assert.equal(
    (await f.db.query("select * from ai_credit_entries where kind='topup'"))
      .rows.length,
    1,
  );
});

test("mismatched amount or merchant receipt cannot imply credited", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  for (const variant of [
    { amount: 10_001, merchant: "synthetic-shop" },
    { amount: 10_000, merchant: "other-shop" },
  ]) {
    const order = await f.create(),
      payment = randomUUID();
    await f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
    });
    await f.credit(order.id, payment, variant.amount, variant.merchant);
    assert.equal((await f.orders.get(f.user, order.id)).credited, false);
    await assert.rejects(
      f.orders.recordProvider(f.user, order.id, {
        providerPaymentId: payment,
        status: "succeeded",
      }),
    );
  }
});

test("cancellation is terminal and does not claim money; review preserves durable request", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const order = await f.create(),
    payment = randomUUID();
  const review = await f.orders.markReviewRequired(f.user, order.id);
  assert.equal(review.status, "review_required");
  assert.deepEqual(review.createPayload, order.createPayload);
  assert.equal(review.createdAt, order.createdAt);
  assert.equal(review.id, order.id);
  await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
  });
  const canceled = await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "canceled",
  });
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.credited, false);
  assert.equal(
    (await f.orders.markReviewRequired(f.user, order.id)).status,
    "canceled",
  );
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
    }),
  );
  await assert.rejects(
    f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "succeeded",
    }),
  );
});

test("parallel create retries serialize to one saved payload and one order", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const request = randomUUID();
  const values = await Promise.all(
    Array.from({ length: 8 }, () => f.create(10_000, request)),
  );
  assert.equal(new Set(values.map((v) => v.id)).size, 1);
  for (const value of values) assert.deepEqual(value, values[0]);
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    1,
  );
});

test("failure after order insert rolls back entire create", async (t) => {
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
              throw new Error("synthetic-order-write-failure");
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
      returnUrl,
    ),
    /synthetic-order-write-failure/,
  );
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    0,
  );
});

test("DB trigger rejects identity, provider reassignment and unposted terminal success", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const order = await f.create(),
    payment = randomUUID();
  for (const column of [
    "id",
    "user_id",
    "request_id",
    "amount_kopeks",
    "merchant_id",
    "test",
    "return_url",
    "create_payload",
    "created_at",
  ]) {
    const mutations: Record<string, unknown> = {
      id: randomUUID(),
      user_id: f.other,
      request_id: randomUUID(),
      amount_kopeks: 101,
      merchant_id: "other-shop",
      test: false,
      return_url: returnUrl + "/other",
      create_payload: "{}",
      created_at: "2000-01-01T00:00:00.000Z",
    };
    await assert.rejects(
      f.db.query(`update payment_topup_orders set ${column}=$2 where id=$1`, [
        order.id,
        mutations[column],
      ]),
    );
  }
  await assert.rejects(
    f.db.query(
      "update payment_topup_orders set provider_payment_id=$2,status='succeeded' where id=$1",
      [order.id, payment],
    ),
  );
  await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
  });
  await assert.rejects(
    f.db.query(
      "update payment_topup_orders set provider_payment_id=$2 where id=$1",
      [order.id, randomUUID()],
    ),
  );
  assert.equal((await f.orders.get(f.user, order.id)).status, "pending");
});

test("live 100 RUB posts exactly 100 CityGo once, preserving paid source and manual receipt obligation", async (t) => {
  const f = await fixture(false);
  t.after(() => f.db.close());
  const request = randomUUID();
  const order = await f.create(10_000, request);
  assert.equal(order.test, false);
  assert.equal(order.createPayload.description, "Пополнение баланса CityGo");
  assert.deepEqual(await f.create(10_000, request), order);
  await assertRealAiDatabaseSafety(f.db);
  assert.deepEqual(
    (
      await f.db.query(
        "select test_payments_seen,real_ai_admitted from account_security_state where id=1",
      )
    ).rows,
    [{ test_payments_seen: false, real_ai_admitted: true }],
  );
  const payment = randomUUID();
  await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "pending",
  });
  await f.credit(order.id, payment);
  await f.credit(order.id, payment);
  const completed = await f.orders.recordProvider(f.user, order.id, {
    providerPaymentId: payment,
    status: "succeeded",
  });
  assert.equal(completed.credited, true);
  assert.equal(completed.test, false);
  assert.equal(
    (await new AiCreditLedger(f.db).status(f.user)).availableMicros,
    100_000_000,
  );
  assert.deepEqual(
    (
      await f.db.query(
        "select kind,gross_micros::text as gross,test from credit_source_lots where paid_operation_id=$1",
        [order.id],
      )
    ).rows,
    [{ kind: "paid", gross: "100000000", test: false }],
  );
  assert.deepEqual(
    (
      await f.db.query(
        `select amount_kopeks::text as amount,buyer_email,registration_status,delivery_status,correction_status
         from npd_receipt_tasks where id=$1 and payment_id=$2`,
        [order.id, payment],
      )
    ).rows,
    [
      {
        amount: "10000",
        buyer_email: "checkout@example.test",
        registration_status: "pending",
        delivery_status: "pending",
        correction_status: "not_required",
      },
    ],
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_topups")).rows.length,
    1,
  );
  assert.equal(
    (await f.db.query("select 1 from ai_credit_entries where kind='topup'"))
      .rows.length,
    1,
  );
  assert.deepEqual(await f.create(10_000, request), completed);
});

test("live order success requires its exact amount, merchant, payment and operation proof", async (t) => {
  const f = await fixture(false);
  t.after(() => f.db.close());
  for (const variant of [
    { amount: 10_001, merchant: "synthetic-shop", unrelated: false },
    { amount: 10_000, merchant: "other-shop", unrelated: false },
    { amount: 10_000, merchant: "synthetic-shop", unrelated: true },
  ]) {
    const order = await f.create();
    const payment = randomUUID();
    await f.orders.recordProvider(f.user, order.id, {
      providerPaymentId: payment,
      status: "pending",
    });
    await f.credit(
      variant.unrelated ? randomUUID() : order.id,
      payment,
      variant.amount,
      variant.merchant,
    );
    assert.equal((await f.orders.get(f.user, order.id)).credited, false);
    await assert.rejects(
      f.orders.recordProvider(f.user, order.id, {
        providerPaymentId: payment,
        status: "succeeded",
      }),
      /Начисление платежа ещё не подтверждено/,
    );
    await assert.rejects(
      f.db.query(
        "update payment_topup_orders set status='succeeded' where id=$1",
        [order.id],
      ),
      /Payment order has no matching posting/,
    );
  }
});

test("test and live orders remain mutually exclusive through application and direct SQL in both directions", async (t) => {
  for (const testPayment of [false, true]) {
    const f = await fixture(testPayment);
    t.after(() => f.db.close());
    const order = await f.create();
    await assert.rejects(
      f.orders.create(
        f.other,
        randomUUID(),
        10_000,
        "synthetic-shop",
        !testPayment,
        returnUrl,
      ),
    );
    await assert.rejects(
      f.db.query(
        `insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload)
         values ($1,$2,$3,10000,'synthetic-shop',$4,$5,'{}')`,
        [randomUUID(), f.other, randomUUID(), !testPayment, returnUrl],
      ),
      /Test payments and real AI cannot share a database/,
    );
    await assert.rejects(
      new AiCreditLedger(f.db).topUpConfirmed(f.user, order.id, {
        providerPaymentId: randomUUID(),
        paidKopeks: 10_000,
        merchantId: "synthetic-shop",
        test: !testPayment,
        verifiedAt: "2026-10-18T00:00:00.000Z",
        verification: "server_get_succeeded",
        currency: "RUB",
      }),
    );
    assert.equal(
      (await f.db.query("select 1 from payment_topup_orders")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("select 1 from ai_credit_topups")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("select 1 from npd_receipt_tasks")).rows.length,
      0,
    );
    assert.deepEqual(await f.orders.get(f.user, order.id), order);
  }
});

test("0019 preserves an existing succeeded sandbox order, exact payload, proof and replay", async (t) => {
  const db = await connectDatabase("pglite://:memory:");
  t.after(() => db.close());
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((name) => /^00(?:0\d|1[0-8])_.*\.sql$/.test(name))
    .sort())
    await db.exec(await readFile(new URL(name, directory), "utf8"));
  const user = await new Repository(db).register(
    "existing-sandbox@example.test",
    "SYNTHETIC-HASH",
  );
  const orders = new PaymentTopupOrders(db);
  const request = randomUUID();
  const order = await orders.create(
    user,
    request,
    10_000,
    "synthetic-shop",
    true,
    returnUrl,
  );
  const payment = randomUUID();
  await new AiCreditLedger(db).topUpConfirmed(user, order.id, {
    providerPaymentId: payment,
    paidKopeks: 10_000,
    merchantId: "synthetic-shop",
    test: true,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  const before = await orders.recordProvider(user, order.id, {
    providerPaymentId: payment,
    status: "succeeded",
  });
  const proofBefore = (await db.query("select * from ai_credit_topups")).rows;
  await db.exec(
    await readFile(new URL("0019_yookassa_live_orders.sql", directory), "utf8"),
  );
  assert.deepEqual(await orders.get(user, order.id), before);
  assert.deepEqual(
    await orders.create(
      user,
      request,
      10_000,
      "synthetic-shop",
      true,
      returnUrl,
    ),
    before,
  );
  assert.deepEqual(
    (await db.query("select * from ai_credit_topups")).rows,
    proofBefore,
  );
  assert.equal(
    (await db.query("select 1 from npd_receipt_tasks")).rows.length,
    0,
  );
  await assert.rejects(
    orders.create(
      user,
      randomUUID(),
      10_000,
      "synthetic-shop",
      false,
      returnUrl,
    ),
  );
  await assert.rejects(assertRealAiDatabaseSafety(db));
});

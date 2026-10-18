import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  AiCreditLedger,
  PaymentTopupOrders,
  Repository,
  connectDatabase,
  migrate,
  type Database,
  type Sql,
} from "@citygo/db";
import {
  PaymentNotificationInbox,
  type PaymentNotification,
} from "./payment-notifications.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in localhost disposable PostgreSQL; PGlite is not race evidence",
  timeout: 60_000,
};
const shop = "123456";
const notification = (id: string) => ({
  type: "notification",
  event: "payment.succeeded",
  object: { id },
});
function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic notification barrier timed out")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base, "Disposable PostgreSQL test opt-in is required");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid disposable PostgreSQL test configuration");
  }
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(["5432", "55438"].includes(url.port || "5432"));
  assert.ok(["/citygo_test", "/citygo_synthetic"].includes(url.pathname));
  assert.ok(url.search === "");
  // Production migrations intentionally bind functions to public. A unique
  // disposable database gives each test its own public schema without rewriting
  // that production SQL or touching any shared application schema.
  const name = "cg_notification_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_notification_test_[a-f0-9]{32}$/);
  const admin = await connectDatabase(base);
  const opened: Database[] = [];
  let created = false;
  t.after(async () => {
    try {
      await Promise.all(opened.map((db) => db.close()));
      if (created) {
        assert.match(name, /^cg_notification_test_[a-f0-9]{32}$/);
        await admin.exec(`drop database "${name}"`);
      }
    } finally {
      await admin.close();
    }
  });
  await admin.exec(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const first = await connectDatabase(url.toString());
  opened.push(first);
  const second = await connectDatabase(url.toString());
  opened.push(second);
  assert.notEqual(
    (await first.query("select pg_backend_pid() as pid")).rows[0]!.pid,
    (await second.query("select pg_backend_pid() as pid")).rows[0]!.pid,
    "The race must use independent PostgreSQL connections",
  );
  await migrate(first);
  const userId = await new Repository(first).register(
    "notification-pg@example.test",
    "SYNTHETIC-NOT-A-REAL-PASSWORD",
  );
  const orders = new PaymentTopupOrders(first);
  const order = await orders.create(
    userId,
    randomUUID(),
    10_000,
    shop,
    false,
    "https://citygo.example/",
  );
  const providerId = randomUUID();
  await orders.recordProvider(userId, order.id, {
    providerPaymentId: providerId,
    status: "pending",
  });
  return { first, second, order, userId, providerId };
}
function inbox(
  db: Database,
  reconcile: (item: PaymentNotification) => Promise<"verified" | "retry">,
) {
  return new PaymentNotificationInbox(db, {
    mode: "live",
    merchantId: shop,
    reconcile,
  });
}

test(
  "PostgreSQL SKIP LOCKED skips another connection's row lock, then concurrent drains claim only once",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const entered = signal(),
      release = signal();
    const reconcile = async () => {
      calls++;
      entered.open();
      await release.promise;
      return "verified" as const;
    };
    const first = inbox(f.first, reconcile),
      second = inbox(f.second, reconcile);
    await first.enqueue(notification(f.providerId));
    const locked = signal(),
      unlock = signal();
    const held = f.first.transaction(async (tx) => {
      await tx.query("select id from payment_notification_inbox for update");
      locked.open();
      await unlock.promise;
    });
    await within(locked.promise);
    try {
      assert.deepEqual(await within(second.processPending(1)), {
        processed: 0,
        retained: 0,
      });
    } finally {
      unlock.open();
    }
    await within(held);
    const winner = first.processPending(1);
    await within(entered.promise);
    try {
      assert.deepEqual(await within(second.processPending(1)), {
        processed: 0,
        retained: 0,
      });
      assert.equal(calls, 1);
      assert.equal(
        (await f.second.query("select status from payment_notification_inbox"))
          .rows[0]!.status,
        "processing",
      );
    } finally {
      release.open();
    }
    assert.deepEqual(await within(winner), { processed: 1, retained: 0 });
    assert.equal(calls, 1);
    assert.equal(await second.enqueue(notification(f.providerId)), "duplicate");
    assert.deepEqual(await second.processPending(1), {
      processed: 0,
      retained: 0,
    });
  },
);

test(
  "PostgreSQL durable replay after actual lease expiry posts a single financial entry across connections",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const ledger = new AiCreditLedger(f.first);
    let calls = 0;
    const reconcile = async (item: PaymentNotification) => {
      calls++;
      await ledger.topUpConfirmed(item.userId, item.localId, {
        providerPaymentId: item.objectId,
        paidKopeks: f.order.amountKopeks,
        merchantId: item.merchantId,
        test: item.test,
        verifiedAt: new Date().toISOString(),
        verification: "server_get_succeeded",
        currency: "RUB",
      });
      return "verified" as const;
    };
    let crash = true;
    const unstable: Database = {
      ...f.first,
      query: (sql, params) => {
        if (
          crash &&
          sql.startsWith("update payment_notification_inbox set status=")
        ) {
          crash = false;
          throw new Error("Synthetic process loss after financial commit");
        }
        // Accelerate only this isolated fixture's claim duration, using the
        // actual PostgreSQL clock/lease predicate rather than a JS clock mock.
        return f.first.query(
          sql.includes("with candidate as")
            ? sql.replace("interval '60 seconds'", "interval '1 millisecond'")
            : sql,
          params,
        );
      },
    };
    const first = inbox(unstable, reconcile);
    await first.enqueue(notification(f.providerId));
    await assert.rejects(first.processPending(1));
    assert.equal(
      (await f.second.query("select status from payment_notification_inbox"))
        .rows[0]!.status,
      "processing",
    );
    await f.second.query("select pg_sleep(0.02)");
    assert.equal(
      (
        await f.second.query(
          "select lease_until<=clock_timestamp() as expired from payment_notification_inbox",
        )
      ).rows[0]!.expired,
      true,
    );
    const restarted = inbox(f.second, reconcile);
    assert.deepEqual(await restarted.processPending(1), {
      processed: 1,
      retained: 0,
    });
    assert.equal(calls, 2); // observation replay is required; money is idempotent.
    assert.equal(
      (
        await f.second.query(
          "select count(*)::integer as n from ai_credit_topups",
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await f.second.query(
          "select count(*)::integer as n from credit_source_lots",
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal((await ledger.status(f.userId)).availableMicros, 100_000_000);
  },
);

test(
  "PostgreSQL actual runtime grants permit inbox verification but deny rewriting identity, deletion and Worker access",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    for (const name of [
      "citygo_api",
      "citygo_worker",
      "citygo_backup",
    ] as const) {
      if (
        !(
          await f.first.query("select 1 from pg_roles where rolname=$1", [name])
        ).rows.length
      ) {
        try {
          await f.first.exec(
            `create role ${name} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
          );
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "42710"
          ))
            throw error;
        }
      }
      assert.deepEqual(
        (
          await f.first.query(
            "select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=$1",
            [name],
          )
        ).rows,
        [
          {
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolbypassrls: false,
          },
        ],
      );
      await f.first.exec(`grant usage on schema public to ${name}`);
    }
    const grants = await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    );
    await f.first.exec(grants.replace(/^\\set[^\r\n]*(?:\r?\n|$)/gm, ""));
    function roleDb(role: "citygo_api" | "citygo_worker"): Database {
      const asRole = <T>(work: (tx: Sql) => Promise<T>) =>
        f.second.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          return work(tx);
        });
      return {
        ...f.second,
        query: <T>(sql: string, params?: unknown[]) =>
          asRole((tx) => tx.query<T>(sql, params)),
        exec: (sql) => asRole((tx) => tx.exec(sql)),
        transaction: asRole,
      };
    }
    const api = roleDb("citygo_api");
    assert.equal(
      (await api.query("select current_user as role")).rows[0]!.role,
      "citygo_api",
    );
    let calls = 0;
    const store = inbox(api, async () => {
      calls++;
      return "verified";
    });
    assert.equal(await store.enqueue(notification(f.providerId)), "queued");
    assert.deepEqual(await store.processPending(1), {
      processed: 1,
      retained: 0,
    });
    assert.equal(calls, 1);
    for (const sql of [
      "update payment_notification_inbox set object_id='11111111-1111-4111-8111-111111111111'",
      "update payment_notification_inbox set merchant_id='999999'",
      "update payment_notification_inbox set test=true",
      "update payment_notification_inbox set event='refund.succeeded'",
      "delete from payment_notification_inbox",
      "truncate table payment_notification_inbox",
    ])
      await assert.rejects(api.exec(sql), { code: "42501" });
    await assert.rejects(
      api.exec(
        "update payment_notification_inbox set status='pending',processed_at=null",
      ),
      { code: "23514" },
    );
    const worker = roleDb("citygo_worker");
    await assert.rejects(
      worker.query("select * from payment_notification_inbox"),
      { code: "42501" },
    );
    await assert.rejects(
      worker.exec("update payment_notification_inbox set status='pending'"),
      { code: "42501" },
    );
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  CONTRACT_VERSION_HEADER,
  paymentAdmissionStatusSchema,
  paymentAdmissionUserStatusSchema,
} from "@citygo/contracts";
import {
  connectDatabase,
  migrate,
  PaymentAdmission,
  Repository,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";
import {
  createPaymentAdmissionBinding,
  registerPaymentReconciliation,
} from "./payment-admission.js";
import type { PaymentReconcileScheduler } from "./payment-reconciler.js";
import type { YooKassaPayment } from "./yookassa.js";
import { ApiDrain } from "./shutdown.js";

const origin = "https://pilot.example.test",
  shop = "123456";
const base = "/v1/admin/payments/admission";
function settings() {
  return readConfig({
    NODE_ENV: "test",
    LLM_PROVIDER: "disabled",
    AI_CREDIT_MODE: "routerai_citygo_10x",
    YOOKASSA_MODE: "live",
    YOOKASSA_SHOP_ID: shop,
    YOOKASSA_SECRET_KEY: "live_SYNTHETIC-NOT-A-REAL-KEY",
    YOOKASSA_RECEIPT_MODE: "npd_manual",
    WEB_ORIGIN: origin,
  });
}
class Clock implements PaymentReconcileScheduler {
  jobs = new Map<number, () => void>();
  next = 0;
  schedule(callback: () => void, delayMs: number) {
    assert.equal(delayMs, 60_000);
    const id = ++this.next;
    this.jobs.set(id, callback);
    return id;
  }
  cancel(handle: unknown) {
    this.jobs.delete(handle as number);
  }
  advance() {
    for (const [id, callback] of [...this.jobs]) {
      this.jobs.delete(id);
      callback();
    }
  }
}
async function until(predicate: () => Promise<boolean> | boolean) {
  for (let n = 0; n < 250; n++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Synthetic lifecycle did not reach expected state");
}
async function fixture(t: TestContext, clock?: Clock) {
  const raw = await connectDatabase("pglite://:memory:");
  await migrate(raw);
  let beforeTransaction: (() => Promise<void>) | undefined;
  let afterOrderCommit: (() => Promise<void>) | undefined;
  const db: Database = {
    ...raw,
    transaction: async (work) => {
      const before = beforeTransaction;
      beforeTransaction = undefined;
      await before?.();
      let inserted = false;
      const result = await raw.transaction((tx) =>
        work({
          ...tx,
          query: async <T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) => {
            const result = await tx.query<T>(sql, params);
            if (sql.startsWith("insert into payment_topup_orders"))
              inserted = true;
            return result;
          },
        }),
      );
      if (inserted) {
        const after = afterOrderCommit;
        afterOrderCommit = undefined;
        await after?.();
      }
      return result;
    },
  };
  const repo = new Repository(db),
    people = [];
  for (const role of ["super_admin", "admin", "user"] as const) {
    const id = await repo.register(
        `${role}@example.test`,
        "SYNTHETIC-UNUSED-HASH",
      ),
      token = randomUUID();
    await db.query("update users set role=$2 where id=$1", [id, role]);
    await repo.createSession(id, tokenHash(token));
    people.push({ id, token });
  }
  const [owner, admin, buyer] = people as [
    { id: string; token: string },
    { id: string; token: string },
    { id: string; token: string },
  ];
  const state = {
    posts: 0,
    gets: 0,
    failGet: false,
    status: "pending" as "pending" | "succeeded",
    privateError: "PRIVATE synthetic merchant/credential details",
    beforeGet: undefined as (() => Promise<void>) | undefined,
  };
  const records = new Map<
    string,
    { id: string; orderId: string; amountKopeks: number }
  >();
  function proof(record: {
    id: string;
    orderId: string;
    amountKopeks: number;
  }): YooKassaPayment {
    return {
      ...record,
      merchantId: shop,
      currency: "RUB",
      test: false,
      status: state.status,
      paid: state.status === "succeeded",
      confirmationUrl: `https://checkout.example.test/${record.id}`,
      verifiedAt: new Date().toISOString(),
    };
  }
  const config = settings(),
    binding = createPaymentAdmissionBinding(config)!;
  const admission = new PaymentAdmission(db, binding);
  const app = await buildApp({
    db,
    config,
    testing: true,
    ...(clock ? { paymentReconcileScheduler: clock } : {}),
    paymentClient: {
      create: async (input) => {
        state.posts++;
        assert.ok(
          (
            await raw.query("select id from payment_topup_orders where id=$1", [
              input.orderId,
            ])
          ).rows.length,
        );
        const record = records.get(input.orderId) ?? {
          id: randomUUID(),
          orderId: input.orderId,
          amountKopeks: input.amountKopeks,
        };
        records.set(input.orderId, record);
        return proof(record);
      },
      get: async (id) => {
        state.gets++;
        await state.beforeGet?.();
        if (state.failGet) throw new Error(state.privateError);
        const record = [...records.values()].find((item) => item.id === id);
        assert.ok(record);
        return proof(record);
      },
    },
    refundClient: {
      createRefund: async () => {
        throw new Error("Unexpected synthetic refund POST");
      },
      getRefund: async () => {
        throw new Error("Unexpected synthetic refund GET");
      },
    },
  });
  t.after(async () => {
    await app.close();
    await raw.close();
  });
  const call = (
    method: "GET" | "POST",
    path: string,
    token = owner.token,
    payload?: object,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const command = async (command: Record<string, unknown>) => {
    const current = await admission.statusAdmin({
      userId: owner.id,
      sessionTokenHash: tokenHash(owner.token),
    });
    return call("POST", `${base}/commands`, owner.token, {
      requestId: randomUUID(),
      expectedRevision: current.revision,
      ...command,
    });
  };
  const healthy = async () => {
    assert.equal(
      (await command({ action: "set_reconciliation", enabled: true }))
        .statusCode,
      200,
    );
    const run = await admission.beginReconciliation();
    assert.ok(run);
    assert.equal(
      await admission.completeReconciliation({ ...run, success: true }),
      true,
    );
  };
  const open = async () => {
    await healthy();
    const reply = await command({
      action: "open",
      mode: "continuous",
      manualNpdResponsibilityAccepted: true,
    });
    assert.equal(reply.statusCode, 200, reply.body);
  };
  return {
    db,
    raw,
    app,
    owner,
    admin,
    buyer,
    state,
    config,
    binding,
    admission,
    call,
    command,
    healthy,
    open,
    create: (requestId = randomUUID()) =>
      call("POST", "/v1/payments/topups", buyer.token, {
        requestId,
        amountKopeks: 10_000,
      }),
    intercept: (hook: () => Promise<void>) => {
      beforeTransaction = hook;
    },
    afterOrder: (hook: () => Promise<void>) => {
      afterOrderCommit = hook;
    },
  };
}

async function pendingLifecycle(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(
    (await f.command({ action: "set_reconciliation", enabled: true }))
      .statusCode,
    200,
  );
  type Run = NonNullable<
    Awaited<ReturnType<PaymentAdmission["beginReconciliation"]>>
  >;
  let signal!: (run: Run) => void;
  let release!: () => void;
  const committed = new Promise<Run>((resolve) => {
    signal = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  class PendingAdmission extends PaymentAdmission {
    override async beginReconciliation() {
      const owned = await super.beginReconciliation();
      assert.ok(owned);
      signal(owned); // The DB transaction committed; only its callback is held.
      await pending;
      return owned;
    }
  }
  const admission = new PendingAdmission(f.db, f.binding);
  const app = Fastify({ logger: false }),
    clock = new Clock();
  let closing = false,
    providerRuns = 0;
  app.addHook("preClose", async () => {
    closing = true;
  });
  registerPaymentReconciliation(app, {
    admission,
    drain: new ApiDrain(),
    testing: true,
    scheduler: clock,
    inbox: {
      enqueueKnownPending: async () => {
        providerRuns++;
        return 0;
      },
      processPending: async () => ({ processed: 0, retained: 0 }),
      hasUnresolvedVerificationFailures: async () => false,
    },
  });
  await app.ready();
  return {
    app,
    clock,
    committed,
    release,
    closing: () => closing,
    providerRuns: () => providerRuns,
  };
}

test("runtime policy excludes keys/technical quotas and binds live merchant/origin/tariff/receipt mode", () => {
  const config = settings(),
    binding = createPaymentAdmissionBinding(config)!;
  assert.match(binding.runtimePolicyId, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    createPaymentAdmissionBinding({
      ...config,
      YOOKASSA_SECRET_KEY: "live_ROTATED-SYNTHETIC-KEY",
      LLM_USER_DAILY_REQUEST_LIMIT: 1,
    }),
    binding,
  );
  assert.notEqual(
    createPaymentAdmissionBinding({ ...config, YOOKASSA_SHOP_ID: "654321" })!
      .runtimePolicyId,
    binding.runtimePolicyId,
  );
  assert.notEqual(
    createPaymentAdmissionBinding({
      ...config,
      WEB_ORIGIN: "https://other.example.test",
    })!.runtimePolicyId,
    binding.runtimePolicyId,
  );
  assert.throws(() =>
    createPaymentAdmissionBinding({
      ...config,
      YOOKASSA_RECEIPT_MODE: "disabled",
    }),
  );
  assert.equal(
    createPaymentAdmissionBinding({ ...config, YOOKASSA_MODE: "disabled" }),
    undefined,
  );
});
test("live HTTP and advertised credit availability default closed, with no provider call or timer", async (t) => {
  const f = await fixture(t);
  const status = await f.call("GET", base);
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(
    paymentAdmissionStatusSchema.parse(status.json()).reason,
    "closed",
  );
  assert.deepEqual(
    paymentAdmissionUserStatusSchema.parse(
      (await f.call("GET", "/v1/payments/availability", f.buyer.token)).json(),
    ),
    { available: false },
  );
  assert.equal(
    (await f.call("GET", "/v1/ai/credit", f.buyer.token)).json().topUpAvailable,
    false,
  );
  assert.equal(
    (await f.call("GET", "/v1/dashboard", f.buyer.token)).json().aiAccess.credit
      .topUpAvailable,
    false,
  );
  assert.equal((await f.create()).statusCode, 503);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.gets, 0);
  assert.equal(
    (await f.db.query("select 1 from payment_topup_orders")).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select 1 from payment_admission_reconciliation_events"))
      .rows.length,
    0,
  );
});
test("admin admission strictly checks current super role/session, schema, CSRF and CAS before mutation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("GET", base, "")).statusCode, 401);
  assert.equal((await f.call("GET", base, f.admin.token)).statusCode, 403);
  assert.equal((await f.call("GET", base, f.buyer.token)).statusCode, 403);
  assert.equal(
    (await f.call("GET", `${base}?merchantId=${shop}`)).statusCode,
    400,
  );
  const input = {
    requestId: randomUUID(),
    expectedRevision: 1,
    action: "open",
    mode: "continuous",
  };
  assert.equal(
    (await f.call("POST", `${base}/commands`, f.owner.token, input)).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call("POST", `${base}/commands`, f.owner.token, {
        ...input,
        manualNpdResponsibilityAccepted: true,
        merchantId: shop,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call(
        "POST",
        `${base}/commands`,
        f.owner.token,
        { ...input, manualNpdResponsibilityAccepted: true },
        { origin: "https://foreign.example.test" },
      )
    ).statusCode,
    403,
  );
  const cmd = { requestId: randomUUID(), expectedRevision: 1, action: "close" };
  assert.equal(
    (await f.call("POST", `${base}/commands`, f.owner.token, cmd)).statusCode,
    200,
  );
  assert.equal(
    (await f.call("POST", `${base}/commands`, f.owner.token, cmd)).statusCode,
    200,
  );
  assert.equal(
    (
      await f.call("POST", `${base}/commands`, f.owner.token, {
        ...cmd,
        requestId: randomUUID(),
      })
    ).statusCode,
    409,
  );
  f.intercept(() =>
    f.raw
      .query("update users set role='admin' where id=$1", [f.owner.id])
      .then(() => {}),
  );
  assert.equal(
    (
      await f.call("POST", `${base}/commands`, f.owner.token, {
        requestId: randomUUID(),
        expectedRevision: 2,
        action: "close",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.db.query("select * from payment_admission_commands")).rows.length,
    1,
  );
});
test("cookie context hashes the actual session, password rotation/logout revoke commands but continuous admission needs no online session", async (t) => {
  const f = await fixture(t);
  await f.open();
  const cookie = await f.call("GET", base, "", undefined, {
    cookie: `citygo=${f.owner.token}`,
  });
  assert.equal(cookie.statusCode, 200, cookie.body);
  assert.equal(
    (
      await f.call("GET", base, "invalid", undefined, {
        cookie: `citygo=${f.owner.token}`,
      })
    ).statusCode,
    401,
  );
  await f.db.query("delete from sessions where token_hash=$1", [
    tokenHash(f.owner.token),
  ]);
  assert.equal((await f.call("GET", base)).statusCode, 401);
  assert.equal(
    (await f.call("GET", "/v1/payments/availability", f.buyer.token)).json()
      .available,
    true,
  );
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.owner.id,
  ]);
  assert.equal(
    (await f.call("GET", "/v1/payments/availability", f.buyer.token)).json()
      .available,
    false,
  );
});
test("close stops fresh/replayed checkout, but reads/GET settlement and NPD obligations remain usable", async (t) => {
  const f = await fixture(t);
  await f.open();
  const request = randomUUID(),
    created = await f.create(request);
  assert.equal(created.statusCode, 200, created.body);
  const orderId = String(created.json().orderId);
  assert.equal((await f.create(request)).statusCode, 200);
  assert.equal(f.state.posts, 1);
  assert.equal((await f.command({ action: "close" })).statusCode, 200);
  assert.equal((await f.create(request)).statusCode, 503);
  assert.equal((await f.create()).statusCode, 503);
  assert.equal(f.state.posts, 1);
  assert.equal(
    (await f.call("GET", `/v1/payments/topups/${orderId}`, f.buyer.token))
      .statusCode,
    200,
  );
  f.state.status = "succeeded";
  const settled = await f.call(
    "POST",
    `/v1/payments/topups/${orderId}/reconcile`,
    f.buyer.token,
    {},
  );
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal(settled.json().credited, true);
  const credit = (await f.call("GET", "/v1/ai/credit", f.buyer.token)).json();
  assert.equal(credit.availableMicros, 100_000_000);
  assert.equal(credit.topUpAvailable, false);
  assert.equal(
    (await f.db.query("select * from npd_receipt_tasks")).rows.length,
    1,
  );
});
test("closing after durable order creation is rechecked immediately before provider POST", async (t) => {
  const f = await fixture(t);
  await f.open();
  f.afterOrder(async () => {
    assert.equal((await f.command({ action: "close" })).statusCode, 200);
  });
  const response = await f.create();
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(f.state.posts, 0);
  assert.equal(
    (await f.db.query("select * from payment_topup_orders")).rows.length,
    1,
  );
});
test("explicit lifecycle reconciliation uses the DB lease, normal pending stays healthy, close preserves reconciliation and stop drains timers", async (t) => {
  const clock = new Clock(),
    f = await fixture(t, clock);
  await f.app.ready();
  await until(() => clock.jobs.size === 1);
  assert.equal(f.state.gets, 0);
  assert.equal(
    (await f.command({ action: "set_reconciliation", enabled: true }))
      .statusCode,
    200,
  );
  clock.advance();
  await until(
    async () =>
      (
        await f.admission.statusAdmin({
          userId: f.owner.id,
          sessionTokenHash: tokenHash(f.owner.token),
        })
      ).reconciliationOk,
  );
  assert.equal(
    (
      await f.command({
        action: "open",
        mode: "continuous",
        manualNpdResponsibilityAccepted: true,
      })
    ).statusCode,
    200,
  );
  const created = await f.create();
  assert.equal(created.statusCode, 200, created.body);
  await until(() => clock.jobs.size === 1);
  clock.advance();
  await until(() => f.state.gets === 1 && clock.jobs.size === 1);
  assert.equal(
    (await f.call("GET", "/v1/payments/availability", f.buyer.token)).json()
      .available,
    true,
  );
  assert.equal(
    (
      await f.db.query<{ last_reason: string }>(
        "select last_reason from payment_notification_inbox",
      )
    ).rows[0]!.last_reason,
    "retry_required",
  );
  assert.equal((await f.command({ action: "close" })).statusCode, 200);
  const before = (
    await f.db.query("select * from payment_admission_reconciliation_events")
  ).rows.length;
  clock.advance();
  await until(
    async () =>
      (
        await f.db.query(
          "select * from payment_admission_reconciliation_events",
        )
      ).rows.length > before,
  );
  await f.app.close();
  assert.equal(clock.jobs.size, 0);
});
test("a failed trusted verification marks health false and blocks new checkout without exposing errors", async (t) => {
  const clock = new Clock(),
    f = await fixture(t, clock);
  await f.app.ready();
  await until(() => clock.jobs.size === 1);
  await f.open();
  const created = await f.create();
  assert.equal(created.statusCode, 200, created.body);
  f.state.failGet = true;
  clock.advance();
  await until(
    async () =>
      (
        await f.db.query<{ reconciliation_ok: boolean }>(
          "select reconciliation_ok from payment_admission",
        )
      ).rows[0]!.reconciliation_ok === false && f.state.gets === 1,
  );
  const state = await f.call("GET", base);
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().reason, "reconciliation_unhealthy");
  assert.doesNotMatch(state.body, /PRIVATE|SYNTHETIC/);
  assert.equal((await f.create()).statusCode, 503);
  assert.equal(f.state.posts, 1);
});

test("a slow old reconciliation cannot claim healthy after disable/re-enable changes its admission revision", async (t) => {
  const clock = new Clock(),
    f = await fixture(t, clock);
  await f.app.ready();
  await until(() => clock.jobs.size === 1);
  await f.open();
  const created = await f.create();
  assert.equal(created.statusCode, 200, created.body);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.beforeGet = () => pending;
  const eventsBefore = (
    await f.db.query("select * from payment_admission_reconciliation_events")
  ).rows.length;
  clock.advance();
  try {
    await until(() => f.state.gets === 1);
    assert.equal(
      (await f.command({ action: "set_reconciliation", enabled: false }))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.command({ action: "set_reconciliation", enabled: true }))
        .statusCode,
      200,
    );
  } finally {
    release();
  }
  await until(() => clock.jobs.size === 1);
  const state = (await f.call("GET", base)).json();
  assert.equal(state.reconciliationOk, false);
  assert.equal(state.reason, "reconciliation_unhealthy");
  assert.equal(
    (await f.db.query("select * from payment_admission_reconciliation_events"))
      .rows.length,
    eventsBefore,
  );
  assert.equal((await f.create()).statusCode, 503);
});

test("shutdown releases a lease committed by a still-pending admission check without starting provider work", async (t) => {
  const f = await fixture(t),
    pending = await pendingLifecycle(f);
  try {
    const owned = await pending.committed;
    assert.equal(
      (
        await f.db.query<{ reconciliation_run_id: string }>(
          "select reconciliation_run_id from payment_admission",
        )
      ).rows[0]!.reconciliation_run_id,
      owned.runId,
    );
    const closed = pending.app.close();
    await until(pending.closing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.release();
    await closed;
    assert.equal(pending.providerRuns(), 0);
    assert.equal(pending.clock.jobs.size, 0);
    const row = (
      await f.db.query<{
        reconciliation_run_id: string | null;
        reconciliation_ok: boolean;
      }>(
        "select reconciliation_run_id,reconciliation_ok from payment_admission",
      )
    ).rows[0]!;
    assert.equal(row.reconciliation_run_id, null);
    assert.equal(row.reconciliation_ok, false);
    const events = (
      await f.db.query<{ run_id: string; success: boolean }>(
        "select run_id,success from payment_admission_reconciliation_events",
      )
    ).rows;
    assert.deepEqual(events, [{ run_id: owned.runId, success: false }]);
    const replacement = await f.admission.beginReconciliation();
    assert.ok(replacement);
  } finally {
    pending.release();
    await pending.app.close();
  }
});

test("shutdown cleanup of an old pending check cannot release a different replacement lease", async (t) => {
  const f = await fixture(t),
    pending = await pendingLifecycle(f);
  try {
    const old = await pending.committed;
    await f.db.query(
      "update payment_admission set reconciliation_run_until=clock_timestamp()-interval '1 second'",
    );
    const replacement = await f.admission.beginReconciliation();
    assert.ok(replacement);
    assert.notEqual(replacement.runId, old.runId);
    const closed = pending.app.close();
    await until(pending.closing);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.release();
    await closed;
    const current = (
      await f.db.query<{ reconciliation_run_id: string }>(
        "select reconciliation_run_id from payment_admission",
      )
    ).rows[0]!;
    assert.equal(current.reconciliation_run_id, replacement.runId);
    assert.equal(
      (
        await f.db.query(
          "select * from payment_admission_reconciliation_events",
        )
      ).rows.length,
      0,
    );
    assert.equal(pending.providerRuns(), 0);
    assert.equal(pending.clock.jobs.size, 0);
  } finally {
    pending.release();
    await pending.app.close();
  }
});
test("readiness requires admission migration22 and fake schedulers cannot escape the isolated test harness", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    200,
  );
  await f.db.query(
    "delete from citygo_migrations where name='0022_payment_admission.sql'",
  );
  assert.equal(
    (await f.app.inject({ method: "GET", url: "/ready" })).statusCode,
    503,
  );
  await assert.rejects(
    buildApp({
      db: f.db,
      config: f.config,
      testing: false,
      paymentReconcileScheduler: new Clock(),
    }),
    /isolated test harness/,
  );
});

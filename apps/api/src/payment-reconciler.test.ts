import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYMENT_RECONCILE_BATCH_LIMIT,
  PAYMENT_RECONCILE_INTERVAL_MS,
  PaymentReconciler,
  type PaymentReconcileFailure,
  type PaymentReconcileResult,
  type PaymentReconcileScheduler,
  type PaymentReconcilerOptions,
} from "./payment-reconciler.js";

class Clock implements PaymentReconcileScheduler {
  now = 0;
  next = 0;
  jobs = new Map<number, { callback: () => void; at: number }>();
  canceled: number[] = [];
  schedule(callback: () => void, delayMs: number) {
    const handle = ++this.next;
    this.jobs.set(handle, { callback, at: this.now + delayMs });
    return handle;
  }
  cancel(handle: unknown) {
    assert.equal(typeof handle, "number");
    this.canceled.push(handle as number);
    this.jobs.delete(handle as number);
  }
  advance(ms: number) {
    this.now += ms;
    for (const [handle, job] of [...this.jobs]) {
      if (job.at <= this.now) {
        this.jobs.delete(handle);
        job.callback();
      }
    }
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
function fixture(overrides: Partial<PaymentReconcilerOptions> = {}) {
  const clock = new Clock();
  const success: Readonly<PaymentReconcileResult>[] = [];
  const failures: PaymentReconcileFailure[] = [];
  let checks = 0;
  let runs = 0;
  const runner = new PaymentReconciler({
    scheduler: clock,
    enabled: async () => {
      checks++;
      return true;
    },
    run: async (limit) => {
      runs++;
      assert.equal(limit, 10);
      return { processed: 2, retained: 1 };
    },
    recordSuccess: async (report) => {
      success.push(report);
    },
    recordFailure: async (reason) => {
      failures.push(reason);
    },
    ...overrides,
  });
  return {
    runner,
    clock,
    success,
    failures,
    checks: () => checks,
    runs: () => runs,
  };
}

test("no automatic start; explicit start owns one bounded cycle and one default-delay timer", async () => {
  const f = fixture();
  assert.equal(PAYMENT_RECONCILE_BATCH_LIMIT, 10);
  assert.equal(PAYMENT_RECONCILE_INTERVAL_MS, 60_000);
  await flush();
  assert.equal(f.checks(), 0);
  assert.equal(f.clock.jobs.size, 0);
  f.runner.start();
  f.runner.start();
  await flush();
  assert.equal(f.checks(), 1);
  assert.equal(f.runs(), 1);
  assert.deepEqual(f.success, [{ processed: 2, retained: 1 }]);
  assert.equal(f.clock.jobs.size, 1);
  f.clock.advance(59_999);
  await flush();
  assert.equal(f.runs(), 1);
  f.clock.advance(1);
  await flush();
  assert.equal(f.runs(), 2);
  assert.equal(f.clock.jobs.size, 1);
  await f.runner.stop();
  assert.equal(f.clock.jobs.size, 0);
});

test("disabled DB flag prevents work/heartbeat and is rechecked each cycle", async () => {
  let enabled = false;
  const f = fixture({ enabled: async () => enabled });
  f.runner.start();
  await flush();
  assert.equal(f.runs(), 0);
  assert.deepEqual(f.success, []);
  assert.deepEqual(f.failures, []);
  enabled = true;
  f.clock.advance(60_000);
  await flush();
  assert.equal(f.runs(), 1);
  enabled = false;
  f.clock.advance(60_000);
  await flush();
  assert.equal(f.runs(), 1);
  await f.runner.stop();
});

test("slow run and heartbeat never overlap or start a catch-up storm", async () => {
  const work = deferred<PaymentReconcileResult>();
  const heartbeat = deferred<void>();
  let runs = 0;
  const f = fixture({
    run: async (limit) => {
      assert.equal(limit, 10);
      runs++;
      return work.promise;
    },
    recordSuccess: async () => heartbeat.promise,
  });
  f.runner.start();
  await flush();
  assert.equal(runs, 1);
  assert.equal(f.clock.jobs.size, 0);
  f.clock.advance(24 * 60 * 60 * 1000);
  await flush();
  assert.equal(runs, 1);
  work.resolve({ processed: 10, retained: 0 });
  await flush();
  assert.equal(f.clock.jobs.size, 0);
  heartbeat.resolve();
  await flush();
  assert.equal(f.clock.jobs.size, 1);
  assert.equal([...f.clock.jobs.values()][0]!.at, f.clock.now + 60_000);
  await f.runner.stop();
});

test("stop drains current work and heartbeat; canceled stale callbacks cannot restart it", async () => {
  const work = deferred<PaymentReconcileResult>();
  const heartbeat = deferred<void>();
  const f = fixture({
    run: async () => work.promise,
    recordSuccess: async () => heartbeat.promise,
  });
  f.runner.start();
  await flush();
  let closed = false;
  const closing = f.runner.stop().then(() => {
    closed = true;
  });
  await flush();
  assert.equal(closed, false);
  work.resolve({ processed: 1, retained: 0 });
  await flush();
  assert.equal(closed, false);
  heartbeat.resolve();
  await closing;
  assert.equal(closed, true);
  assert.equal(f.clock.jobs.size, 0);
  f.clock.advance(1_000_000);
  await flush();
  assert.throws(() => f.runner.start(), /closed/);
  await f.runner.stop();

  const idle = fixture();
  idle.runner.start();
  await flush();
  const stale = [...idle.clock.jobs.values()][0]!.callback;
  await idle.runner.stop();
  stale();
  await flush();
  assert.equal(idle.runs(), 1);
  assert.equal(idle.clock.jobs.size, 0);
});

test("stop during admission check prevents a later provider callback", async () => {
  const enabled = deferred<boolean>();
  const f = fixture({ enabled: async () => enabled.promise });
  f.runner.start();
  await flush();
  const closing = f.runner.stop();
  enabled.resolve(true);
  await closing;
  assert.equal(f.runs(), 0);
  assert.deepEqual(f.success, []);
  assert.equal(f.clock.jobs.size, 0);
});

test("immediate close and closing an unstarted runner schedule nothing", async () => {
  for (const start of [false, true]) {
    const f = fixture();
    if (start) f.runner.start();
    await f.runner.stop();
    assert.equal(f.checks(), 0);
    assert.equal(f.clock.jobs.size, 0);
    assert.throws(() => f.runner.start(), /closed/);
  }
});

test("callback failures emit safe enums only and wait for the next interval", async () => {
  for (const failure of ["enabled", "run", "recordSuccess"] as const) {
    let attempts = 0;
    const reasons: PaymentReconcileFailure[] = [];
    const fail = () => {
      attempts++;
      throw new Error("PRIVATE_PROVIDER_RESPONSE_KEY_MUST_NOT_ESCAPE");
    };
    const f = fixture({
      [failure]: fail,
      recordFailure: async (reason) => {
        reasons.push(reason);
        throw new Error("PRIVATE_HEARTBEAT_FAILURE_MUST_NOT_ESCAPE");
      },
    });
    f.runner.start();
    await flush();
    assert.equal(attempts, 1);
    assert.deepEqual(reasons, [
      failure === "enabled"
        ? "admission_check_failed"
        : failure === "run"
          ? "reconciliation_failed"
          : "heartbeat_failed",
    ]);
    assert.doesNotMatch(JSON.stringify(reasons), /PRIVATE|KEY|RESPONSE/);
    f.clock.advance(59_999);
    await flush();
    assert.equal(attempts, 1);
    f.clock.advance(1);
    await flush();
    assert.equal(attempts, 2);
    await f.runner.stop();
  }
});

test("malformed or oversized results cannot mark a successful heartbeat", async () => {
  for (const report of [
    null,
    [],
    { processed: -1, retained: 0 },
    { processed: 0.5, retained: 0 },
    { processed: Number.NaN, retained: 0 },
    { processed: Number.POSITIVE_INFINITY, retained: 0 },
    { processed: 10, retained: 1 },
    { processed: "1", retained: 0 },
  ]) {
    const f = fixture({ run: async () => report as PaymentReconcileResult });
    f.runner.start();
    await flush();
    assert.deepEqual(f.success, []);
    assert.deepEqual(f.failures, ["invalid_result"]);
    await f.runner.stop();
  }
  const f = fixture({
    run: async () => ({ processed: 0, retained: 0, private: "PRIVATE_KEY" }),
  });
  f.runner.start();
  await flush();
  assert.deepEqual(f.success, [{ processed: 0, retained: 0 }]);
  assert.equal(Object.isFrozen(f.success[0]), true);
  await f.runner.stop();
});

test("invalid admission values and intervals fail closed", async () => {
  const f = fixture({ enabled: async () => "true" as unknown as boolean });
  f.runner.start();
  await flush();
  assert.equal(f.runs(), 0);
  assert.deepEqual(f.failures, ["admission_check_failed"]);
  await f.runner.stop();
  for (const intervalMs of [0, -1, 999, 300_001, 60_000.5, Number.NaN])
    assert.throws(() => fixture({ intervalMs }), /Invalid.*interval/);
});

test("scheduler failure is observed once with no retry loop or escaped error", async () => {
  const reasons: PaymentReconcileFailure[] = [];
  const f = fixture({
    scheduler: {
      schedule() {
        throw new Error("PRIVATE_SCHEDULER_DETAIL");
      },
      cancel() {
        throw new Error("PRIVATE_CANCEL_DETAIL");
      },
    },
    recordFailure: async (reason) => {
      reasons.push(reason);
      throw new Error("PRIVATE_RECORD_DETAIL");
    },
  });
  f.runner.start();
  await flush();
  assert.deepEqual(reasons, ["scheduler_failed"]);
  assert.equal(f.runs(), 1);
  await f.runner.stop();
  assert.deepEqual(reasons, ["scheduler_failed"]);
});

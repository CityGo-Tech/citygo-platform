import assert from "node:assert/strict";
import test from "node:test";
import {
  PostpayReconciler,
  POSTPAY_RECONCILE_BATCH_LIMIT,
  POSTPAY_RECONCILE_INTERVAL_MS,
  POSTPAY_RECONCILE_TIMEOUT_MS,
  POSTPAY_RECONCILE_MAX_BACKOFF_MS,
  type PostpayReconcilerOptions,
  type PostpayReconcileFailure,
  type PostpayReconcileResult,
  type PostpayReconcileScheduler,
} from "./postpay-reconciler.js";

class Clock implements PostpayReconcileScheduler {
  now = 0;
  sequence = 0;
  jobs = new Map<number, { callback(): void; at: number }>();
  canceled: number[] = [];
  schedule(callback: () => void, delay: number) {
    const id = ++this.sequence;
    this.jobs.set(id, { callback, at: this.now + delay });
    return id;
  }
  cancel(handle: unknown) {
    assert.equal(typeof handle, "number");
    this.canceled.push(handle as number);
    this.jobs.delete(handle as number);
  }
  advance(delay: number) {
    this.now += delay;
    for (const [id, job] of [...this.jobs]) {
      if (job.at <= this.now) {
        this.jobs.delete(id);
        job.callback();
      }
    }
  }
  nextDelay() {
    assert.equal(this.jobs.size, 1);
    return [...this.jobs.values()][0]!.at - this.now;
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
function fixture(options: Partial<PostpayReconcilerOptions> = {}) {
  const clock = new Clock(),
    failures: PostpayReconcileFailure[] = [],
    signals: AbortSignal[] = [];
  let calls = 0;
  const runner = new PostpayReconciler({
    scheduler: clock,
    run: async (limit, signal) => {
      assert.equal(limit, POSTPAY_RECONCILE_BATCH_LIMIT);
      calls++;
      signals.push(signal);
      return { processed: 1, retained: 2 };
    },
    onFailure: (code) => {
      failures.push(code);
    },
    ...options,
  });
  return { clock, runner, failures, signals, calls: () => calls };
}

test("constructor/readiness does not run work; explicit idempotent start owns one batch and the default delay", async () => {
  const f = fixture();
  assert.equal(POSTPAY_RECONCILE_BATCH_LIMIT, 10);
  assert.equal(POSTPAY_RECONCILE_INTERVAL_MS, 30_000);
  assert.equal(POSTPAY_RECONCILE_TIMEOUT_MS, 15_000);
  await flush();
  assert.equal(f.calls(), 0);
  assert.equal(f.clock.jobs.size, 0);
  f.runner.start();
  f.runner.start();
  assert.equal(f.calls(), 0);
  await flush();
  assert.equal(f.calls(), 1);
  assert.equal(f.signals[0]!.aborted, false);
  assert.equal(f.clock.nextDelay(), 30_000);
  f.clock.advance(29_999);
  await flush();
  assert.equal(f.calls(), 1);
  f.clock.advance(1);
  await flush();
  assert.equal(f.calls(), 2);
  assert.notEqual(f.signals[0], f.signals[1]);
  await f.runner.stop();
  assert.equal(f.clock.jobs.size, 0);
});

test("a slow callback has concurrency one, no catch-up burst, and starts its delay only after completion", async () => {
  const work = deferred<PostpayReconcileResult>();
  let calls = 0;
  const f = fixture({
    run: async () => {
      calls++;
      return work.promise;
    },
  });
  f.runner.start();
  await flush();
  assert.equal(calls, 1);
  f.clock.advance(14_999);
  await flush();
  assert.equal(calls, 1);
  work.resolve({ processed: 0, retained: 10 });
  await flush();
  assert.equal(f.clock.nextDelay(), 30_000);
  f.clock.advance(30_000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(f.clock.nextDelay(), 30_000);
  await f.runner.stop();
});

test("unknown costs remain retained facts across cycles; the scheduler never converts them to zero or terminal status", async () => {
  const unknown = Object.freeze({ processed: 0, retained: 1 });
  const original = JSON.stringify(unknown);
  let calls = 0;
  const f = fixture({
    run: async () => {
      calls++;
      return unknown;
    },
  });
  f.runner.start();
  await flush();
  for (let i = 0; i < 3; i++) {
    f.clock.advance(30_000);
    await flush();
  }
  assert.equal(calls, 4);
  assert.equal(JSON.stringify(unknown), original);
  assert.deepEqual(f.failures, []);
  assert.equal(f.clock.nextDelay(), 30_000);
  await f.runner.stop();
});

test("failed GET batches back off to a bound without immediate retry, and a valid result resets the delay", async () => {
  let failing = true,
    calls = 0;
  const f = fixture({
    run: async () => {
      calls++;
      if (failing) throw new Error("PRIVATE_UPSTREAM_BODY_NOT_LOGGED");
      return { processed: 0, retained: 1 };
    },
  });
  f.runner.start();
  await flush();
  for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    assert.equal(f.clock.nextDelay(), delay);
    const before = calls;
    f.clock.advance(delay - 1);
    await flush();
    assert.equal(calls, before);
    f.clock.advance(1);
    await flush();
  }
  assert.equal(f.clock.nextDelay(), POSTPAY_RECONCILE_MAX_BACKOFF_MS);
  assert.deepEqual(f.failures, Array(6).fill("reconciliation_failed"));
  failing = false;
  f.clock.advance(300_000);
  await flush();
  assert.equal(f.clock.nextDelay(), 30_000);
  assert.equal(f.failures.length, 6);
  await f.runner.stop();
});

test("the batch deadline aborts GET work and retries only after the bounded failure delay", async () => {
  const signals: AbortSignal[] = [];
  const f = fixture({
    run: async (_limit, signal) => {
      signals.push(signal);
      return new Promise((_yes, no) => {
        signal.addEventListener(
          "abort",
          () => no(new Error("private timeout detail")),
          { once: true },
        );
      });
    },
  });
  f.runner.start();
  await flush();
  f.clock.advance(14_999);
  assert.equal(signals[0]!.aborted, false);
  f.clock.advance(1);
  await flush();
  assert.equal(signals[0]!.aborted, true);
  assert.deepEqual(f.failures, ["reconciliation_timed_out"]);
  assert.equal(f.clock.nextDelay(), 60_000);
  f.clock.advance(60_000);
  await flush();
  assert.equal(signals.length, 2);
  assert.equal(signals[1]!.aborted, false);
  await f.runner.stop();
  assert.equal(signals[1]!.aborted, true);
  assert.deepEqual(f.failures, ["reconciliation_timed_out"]);
  assert.equal(f.clock.jobs.size, 0);
});

test("an abort-ignoring callback keeps the lane occupied; stop aborts and drains without overlap or late revival", async () => {
  const work = deferred<PostpayReconcileResult>();
  let calls = 0,
    signal!: AbortSignal;
  const f = fixture({
    run: async (_limit, value) => {
      calls++;
      signal = value;
      return work.promise;
    },
  });
  f.runner.start();
  await flush();
  f.clock.advance(15_000);
  await flush();
  assert.equal(signal.aborted, true);
  f.clock.advance(24 * 60 * 60 * 1000);
  await flush();
  assert.equal(calls, 1);
  let stopped = false;
  const stopping = f.runner.stop().then(() => {
    stopped = true;
  });
  await flush();
  assert.equal(stopped, false);
  work.resolve({ processed: 0, retained: 1 });
  await stopping;
  assert.equal(stopped, true);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(calls, 1);
  assert.throws(() => f.runner.start(), /closed/);
  await f.runner.stop();
});

test("stop during idle wait cancels the timer; stale callbacks and immediate stop before start cannot execute work", async () => {
  const f = fixture();
  f.runner.start();
  await flush();
  const stale = [...f.clock.jobs.values()][0]!.callback;
  await f.runner.stop();
  stale();
  f.clock.advance(1_000_000);
  await flush();
  assert.equal(f.calls(), 1);
  assert.equal(f.clock.jobs.size, 0);
  const second = fixture();
  second.runner.start();
  await second.runner.stop();
  assert.equal(second.calls(), 0);
  const third = fixture();
  await third.runner.stop();
  assert.throws(() => third.runner.start(), /closed/);
});

test("invalid result counts do not escape as provider data and cannot trigger a retry storm", async () => {
  for (const value of [
    null,
    [],
    { processed: -1, retained: 0 },
    { processed: 0, retained: 11 },
    { processed: 5, retained: 6 },
    { processed: 0.5, retained: 0 },
    { processed: NaN, retained: 0 },
    {
      get processed() {
        throw new Error("private");
      },
      retained: 0,
    },
  ]) {
    const f = fixture({ run: async () => value as PostpayReconcileResult });
    f.runner.start();
    await flush();
    assert.deepEqual(f.failures, ["invalid_result"]);
    assert.equal(f.clock.nextDelay(), 60_000);
    await f.runner.stop();
  }
});

test("safe failure callbacks may fail; neither synchronous run errors nor asynchronous observers become unhandled rejections", async () => {
  let observations = 0;
  const f = fixture({
    run() {
      throw new Error("private upstream response");
    },
    onFailure: async (code) => {
      assert.equal(code, "reconciliation_failed");
      observations++;
      throw new Error("private observer error");
    },
  });
  f.runner.start();
  await flush();
  assert.equal(observations, 1);
  assert.equal(f.clock.nextDelay(), 60_000);
  await f.runner.stop();
});

test("scheduler failure closes the lane instead of manufacturing unbounded zero-delay retries", async () => {
  const failures: PostpayReconcileFailure[] = [];
  const clock: PostpayReconcileScheduler = {
    schedule() {
      throw new Error("private timer");
    },
    cancel() {},
  };
  let calls = 0;
  const runner = new PostpayReconciler({
    scheduler: clock,
    run: async () => {
      calls++;
      return { processed: 0, retained: 0 };
    },
    onFailure: (code) => {
      failures.push(code);
    },
  });
  runner.start();
  await flush();
  assert.equal(calls, 0);
  assert.deepEqual(failures, ["scheduler_failed"]);
  await runner.stop();
});

test("public configuration rejects unsafe intervals, deadlines and batch sizes, and honors smaller bounded batches", async () => {
  const run = async () => ({ processed: 0, retained: 0 });
  for (const intervalMs of [0, -1, 999, 300_001, Infinity, NaN, 1500.5])
    assert.throws(() => new PostpayReconciler({ run, intervalMs }), /interval/);
  for (const timeoutMs of [0, 999, 60_001, Infinity, NaN, 1500.5])
    assert.throws(() => new PostpayReconciler({ run, timeoutMs }), /timeout/);
  for (const limit of [0, -1, 11, Infinity, NaN, 1.5])
    assert.throws(() => new PostpayReconciler({ run, limit }), /limit/);
  let actual = 0;
  const f = fixture({
    intervalMs: 1000,
    timeoutMs: 1000,
    limit: 2,
    run: async (limit) => {
      actual = limit;
      return { processed: 1, retained: 1 };
    },
  });
  f.runner.start();
  await flush();
  assert.equal(actual, 2);
  assert.equal(f.clock.nextDelay(), 1000);
  await f.runner.stop();
});

test("a canceled old deadline cannot abort a new batch or schedule another settlement", async () => {
  const first = deferred<PostpayReconcileResult>();
  const second = deferred<PostpayReconcileResult>();
  const signals: AbortSignal[] = [];
  const f = fixture({
    run: async (_limit, signal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    },
  });
  f.runner.start();
  await flush();
  const staleDeadline = [...f.clock.jobs.values()][0]!.callback;
  first.resolve({ processed: 0, retained: 1 });
  await flush();
  f.clock.advance(30_000);
  await flush();
  assert.equal(signals.length, 2);
  staleDeadline();
  await flush();
  assert.equal(signals[1]!.aborted, false);
  assert.deepEqual(f.failures, []);
  second.resolve({ processed: 1, retained: 0 });
  await flush();
  assert.equal(f.clock.nextDelay(), 30_000);
  await f.runner.stop();
});

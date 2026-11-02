// Scheduling only. The injected callback owns DB leases and bounded GET-only
// cost lookups. This module never retries a model request, invents a terminal
// fact or interprets an unknown provider cost as zero.
export const POSTPAY_RECONCILE_BATCH_LIMIT = 10;
export const POSTPAY_RECONCILE_INTERVAL_MS = 30_000;
export const POSTPAY_RECONCILE_TIMEOUT_MS = 15_000;
export const POSTPAY_RECONCILE_MAX_BACKOFF_MS = 300_000;

export type PostpayReconcileResult = { processed: number; retained: number };
export type PostpayReconcileFailure =
  | "reconciliation_failed"
  | "reconciliation_timed_out"
  | "invalid_result"
  | "scheduler_failed";
export type PostpayReconcileScheduler = {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};
export type PostpayReconcilerOptions = {
  // The callback must honor cancellation and bound its own DB/HTTP operations.
  // Retained means still unknown/pending, not a zero-cost or terminal result.
  run(limit: number, signal: AbortSignal): Promise<PostpayReconcileResult>;
  onFailure?(reason: PostpayReconcileFailure): void | Promise<void>;
  scheduler?: PostpayReconcileScheduler;
  intervalMs?: number;
  timeoutMs?: number;
  limit?: number;
};
const timers: PostpayReconcileScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
function validResult(value: unknown, limit: number): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const item = value as PostpayReconcileResult;
    return (
      Number.isSafeInteger(item.processed) &&
      Number.isSafeInteger(item.retained) &&
      item.processed >= 0 &&
      item.retained >= 0 &&
      item.processed + item.retained <= limit
    );
  } catch {
    return false;
  }
}
export class PostpayReconciler {
  #options: PostpayReconcilerOptions;
  #scheduler: PostpayReconcileScheduler;
  #intervalMs: number;
  #timeoutMs: number;
  #limit: number;
  #started = false;
  #active = false;
  #closed = false;
  #completion?: Promise<void>;
  #controller?: AbortController;
  #deadline?: { handle?: unknown };
  #waiting?: { handle?: unknown; wake(): void };

  constructor(options: PostpayReconcilerOptions) {
    const interval = options.intervalMs ?? POSTPAY_RECONCILE_INTERVAL_MS;
    const timeout = options.timeoutMs ?? POSTPAY_RECONCILE_TIMEOUT_MS;
    const limit = options.limit ?? POSTPAY_RECONCILE_BATCH_LIMIT;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 1000 ||
      interval > POSTPAY_RECONCILE_MAX_BACKOFF_MS
    )
      throw new Error("Invalid postpay reconciliation interval");
    if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60_000)
      throw new Error("Invalid postpay reconciliation timeout");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > POSTPAY_RECONCILE_BATCH_LIMIT
    )
      throw new Error("Invalid postpay reconciliation batch limit");
    const scheduler = options.scheduler ?? timers;
    if (
      typeof options.run !== "function" ||
      typeof scheduler.schedule !== "function" ||
      typeof scheduler.cancel !== "function"
    )
      throw new Error("Invalid postpay reconciliation callback or scheduler");
    this.#options = { ...options };
    this.#scheduler = scheduler;
    this.#intervalMs = interval;
    this.#timeoutMs = timeout;
    this.#limit = limit;
  }

  start(): void {
    if (this.#closed) throw new Error("Postpay reconciler is closed");
    if (this.#started) return;
    this.#started = true;
    this.#active = true;
    // Readiness never waits for a batch. Register the completion before any
    // callback can run or make a reentrant lifecycle call.
    this.#completion = Promise.resolve()
      .then(() => this.#loop())
      .catch(async () => {
        this.#active = false;
        await this.#failure("scheduler_failed");
      });
  }

  async stop(): Promise<void> {
    this.#closed = true;
    this.#active = false;
    this.#controller?.abort();
    const deadline = this.#deadline;
    this.#deadline = undefined;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    for (const timer of [deadline, waiting]) {
      try {
        if (timer?.handle !== undefined) this.#scheduler.cancel(timer.handle);
      } catch {
        // Stale callbacks have identity/lifecycle guards and cannot revive work.
      }
    }
    waiting?.wake();
    // Never race a timeout against the real settlement callback and start more
    // work. A callback ignoring abort keeps the lane occupied until it drains.
    await this.#completion;
  }

  async #failure(reason: PostpayReconcileFailure) {
    try {
      await this.#options.onFailure?.(reason);
    } catch {
      // Only a fixed safe code is observable; no provider/body/error fields.
    }
  }

  async #cycle(): Promise<boolean> {
    const controller = new AbortController();
    this.#controller = controller;
    const deadline = { handle: undefined as unknown };
    this.#deadline = deadline;
    let timedOut = false;
    try {
      deadline.handle = this.#scheduler.schedule(() => {
        if (!this.#active || this.#controller !== controller) return;
        timedOut = true;
        controller.abort();
      }, this.#timeoutMs);
      if (!this.#active) return false;
      let value: unknown;
      try {
        value = await this.#options.run(this.#limit, controller.signal);
      } catch {
        if (!this.#active) return false;
        await this.#failure(
          timedOut ? "reconciliation_timed_out" : "reconciliation_failed",
        );
        return false;
      }
      if (!this.#active) return false;
      if (timedOut) {
        await this.#failure("reconciliation_timed_out");
        return false;
      }
      if (!validResult(value, this.#limit)) {
        await this.#failure("invalid_result");
        return false;
      }
      return true;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      if (this.#deadline === deadline) {
        this.#deadline = undefined;
        if (deadline.handle !== undefined)
          this.#scheduler.cancel(deadline.handle);
      }
    }
  }

  async #loop(): Promise<void> {
    let failures = 0;
    while (this.#active) {
      const success = await this.#cycle();
      if (!this.#active) return;
      failures = success ? 0 : Math.min(failures + 1, 16);
      const delay = Math.min(
        POSTPAY_RECONCILE_MAX_BACKOFF_MS,
        this.#intervalMs * 2 ** failures,
      );
      // Delay starts after the real callback drains; no overlap, catch-up burst,
      // setInterval, immediate error retry or model POST retry.
      await new Promise<void>((wake) => {
        const waiting = { wake, handle: undefined as unknown };
        this.#waiting = waiting;
        try {
          waiting.handle = this.#scheduler.schedule(() => {
            if (this.#waiting !== waiting) return;
            this.#waiting = undefined;
            wake();
          }, delay);
        } catch (error) {
          this.#waiting = undefined;
          throw error;
        }
      });
    }
  }
}

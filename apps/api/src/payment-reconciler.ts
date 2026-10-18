// API-owned scheduling only. Explicit wiring supplies the already bounded,
// GET-backed settlement callback; this module has no payment/refund creation,
// credentials, database transactions, existing Worker rights or auto-start.
export const PAYMENT_RECONCILE_BATCH_LIMIT = 10 as const;
export const PAYMENT_RECONCILE_INTERVAL_MS = 60_000;

export type PaymentReconcileResult = {
  processed: number;
  retained: number;
};
export type PaymentReconcileFailure =
  | "admission_check_failed"
  | "reconciliation_failed"
  | "invalid_result"
  | "heartbeat_failed"
  | "scheduler_failed";

export type PaymentReconcileScheduler = {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};
export type PaymentReconcilerOptions = {
  // This checks the shared DB flag, not a process-local activation boolean.
  enabled(): Promise<boolean>;
  run(
    limit: typeof PAYMENT_RECONCILE_BATCH_LIMIT,
  ): Promise<PaymentReconcileResult>;
  // These are trusted internal heartbeat writers, not client evidence. They
  // must use their own short transactions, outside the provider GET callback.
  recordSuccess(result: Readonly<PaymentReconcileResult>): Promise<void>;
  recordFailure(reason: PaymentReconcileFailure): Promise<void>;
  intervalMs?: number;
  scheduler?: PaymentReconcileScheduler;
};

const scheduler: PaymentReconcileScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function result(value: unknown): PaymentReconcileResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const item = value as PaymentReconcileResult;
  if (
    !Number.isInteger(item.processed) ||
    !Number.isInteger(item.retained) ||
    item.processed < 0 ||
    item.retained < 0 ||
    item.processed + item.retained > PAYMENT_RECONCILE_BATCH_LIMIT
  )
    return null;
  // Never pass arbitrary provider/error/result fields to the heartbeat writer.
  return Object.freeze({ processed: item.processed, retained: item.retained });
}

export class PaymentReconciler {
  #options: PaymentReconcilerOptions;
  #scheduler: PaymentReconcileScheduler;
  #intervalMs: number;
  #started = false;
  #active = false;
  #closed = false;
  #completion?: Promise<void>;
  #waiting?: { handle?: unknown; wake(): void };

  constructor(options: PaymentReconcilerOptions) {
    const intervalMs = options.intervalMs ?? PAYMENT_RECONCILE_INTERVAL_MS;
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1000 ||
      intervalMs > 300_000
    )
      throw new Error("Invalid payment reconciliation interval");
    this.#options = options;
    this.#scheduler = options.scheduler ?? scheduler;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#closed) throw new Error("Payment reconciler is closed");
    if (this.#started) return;
    this.#started = true;
    this.#active = true;
    // Set completion before invoking any callbacks, including synchronous
    // failures/reentrant lifecycle calls. Every eventual rejection is observed.
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
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = undefined;
      try {
        if (waiting.handle !== undefined)
          this.#scheduler.cancel(waiting.handle);
      } catch {
        // A canceled/stale timer callback cannot revive a closed lifecycle.
        // Do not log scheduler exceptions or manufacture another retry timer.
      } finally {
        waiting.wake();
      }
    }
    // Drain, do not abandon an admitted provider GET/settlement. The transport
    // callback must have its own deadline; shutdown never treats timeout as a
    // canceled payment/refund or releases reserved money.
    await this.#completion;
  }

  async #failure(reason: PaymentReconcileFailure): Promise<void> {
    try {
      await this.#options.recordFailure(reason);
    } catch {
      // Shared DB/heartbeat failure is not permission to run more work. A
      // failing heartbeat cannot escape as an unhandled rejection or raw log.
    }
  }

  async #cycle(): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await this.#options.enabled();
    } catch {
      await this.#failure("admission_check_failed");
      return;
    }
    if (enabled === false || !this.#active) return;
    if (enabled !== true) {
      await this.#failure("admission_check_failed");
      return;
    }
    let completed: PaymentReconcileResult | null;
    try {
      completed = result(
        await this.#options.run(PAYMENT_RECONCILE_BATCH_LIMIT),
      );
    } catch {
      await this.#failure("reconciliation_failed");
      return;
    }
    if (!completed) {
      await this.#failure("invalid_result");
      return;
    }
    try {
      await this.#options.recordSuccess(completed);
    } catch {
      await this.#failure("heartbeat_failed");
    }
  }

  async #loop(): Promise<void> {
    while (this.#active) {
      await this.#cycle();
      if (!this.#active) return;
      // Fixed delay AFTER completion includes slow GET/heartbeat time. There
      // is no overlap, catch-up burst, zero-delay failure retry or setInterval.
      await new Promise<void>((wake) => {
        const waiting = { wake, handle: undefined as unknown };
        this.#waiting = waiting;
        waiting.handle = this.#scheduler.schedule(() => {
          if (this.#waiting !== waiting) return;
          this.#waiting = undefined;
          wake();
        }, this.#intervalMs);
      });
    }
  }
}

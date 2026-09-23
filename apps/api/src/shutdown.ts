import type { FastifyInstance } from "fastify";
import { DomainError } from "@citygo/db";

// Longest supported provider request is 240s. Leave time for DB settlement,
// then cancel cooperative streams; Docker must allow more than the total 300s.
export const API_DRAIN_MS = 270_000;
export const API_CLEANUP_MS = 30_000;

export class ApiDrain {
  private draining = false;
  private count = 0;
  private readonly waiters = new Set<() => void>();
  private readonly abort = new AbortController();

  get active() {
    return this.count;
  }

  get signal() {
    return this.abort.signal;
  }

  begin() {
    this.draining = true;
  }

  cancel() {
    this.begin();
    this.abort.abort();
  }

  async run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (this.draining)
      throw new DomainError(
        503,
        "Сервис обновляется. Дождитесь завершения обновления и проверьте историю перед повторной отправкой.",
        "SERVICE_UNAVAILABLE",
      );
    this.count++;
    try {
      return await operation();
    } finally {
      this.count--;
      if (!this.count) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    }
  }

  whenIdle(): Promise<void> {
    if (!this.count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }
}

export function registerDrain(app: FastifyInstance, drain: ApiDrain) {
  app.addHook("onRoute", (route) => {
    if (route.url !== "/ready" && !route.url.startsWith("/v1/")) return;
    const handler = route.handler;
    route.handler = function (request, reply) {
      // Track the handler promise, NOT the socket: hijacked SSE can still be
      // saving its interrupted response after the client has disconnected.
      return drain.run(() => handler.call(this, request, reply));
    };
  });
}

export function createShutdown(
  drain: ApiDrain,
  close: () => Promise<unknown>,
  timing = { graceMs: API_DRAIN_MS, cleanupMs: API_CLEANUP_MS },
) {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    drain.begin(); // Synchronous admission barrier, including repeated signals.
    const cancelTimer = setTimeout(() => drain.cancel(), timing.graceMs);
    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        drain.cancel();
        reject(new Error("API shutdown deadline exceeded"));
      }, timing.graceMs + timing.cleanupMs);
    });
    pending = Promise.race([
      (async () => {
        await drain.whenIdle();
        clearTimeout(cancelTimer);
        await close(); // Only now may Fastify's onClose hook close the DB.
      })(),
      deadline,
    ]).finally(() => {
      clearTimeout(cancelTimer);
      clearTimeout(deadlineTimer);
    });
    return pending;
  };
}

export function installShutdown(app: FastifyInstance, drain: ApiDrain) {
  const shutdown = createShutdown(drain, () => app.close());
  let started = false;
  const onSignal = () => {
    if (started) return;
    started = true;
    app.log.info({ active: drain.active }, "API draining");
    void shutdown().then(
      () => {
        remove();
        app.log.info("API shutdown complete");
      },
      () => {
        // Do not print config, requests or driver errors. A hung handler must
        // not be reported as a clean drain or race against a premature DB close.
        app.log.error({ active: drain.active }, "API shutdown failed");
        process.exit(1);
      },
    );
  };
  const signals = ["SIGINT", "SIGTERM"] as const;
  const remove = () => {
    for (const signal of signals) process.off(signal, onSignal);
  };
  for (const signal of signals) process.on(signal, onSignal);
  return remove;
}

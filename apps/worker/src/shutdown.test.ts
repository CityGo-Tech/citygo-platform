import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Database } from "@citygo/db";
import { runWorkerOnce, WORKER_SHUTDOWN_MS } from "./shutdown.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const signals = new EventEmitter();
  const calls: string[] = [];
  const db = {
    close: async () => {
      calls.push("close");
    },
  } as Database;
  const connect = async () => {
    calls.push("connect");
    return db;
  };
  const maintain = async () => {
    calls.push("maintain");
  };
  const options = {
    signals,
    shutdownMs: 1000,
    onDrain: () => {
      calls.push("drain");
    },
  };
  return { signals, calls, db, connect, maintain, options };
}
function detached(signals: EventEmitter) {
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
}

test("normal one-shot completes once and closes before success", async () => {
  const f = fixture();
  assert.equal(WORKER_SHUTDOWN_MS, 60_000);
  assert.equal(
    await runWorkerOnce(f.connect, f.maintain, f.options),
    "completed",
  );
  assert.deepEqual(f.calls, ["connect", "maintain", "close"]);
  detached(f.signals);
});

test("repeated signals wait for the accepted transaction AND close", async () => {
  const f = fixture(),
    started = deferred(),
    transaction = deferred(),
    closed = deferred(),
    closing = deferred();
  f.db.close = async () => {
    f.calls.push("close");
    closing.resolve();
    await closed.promise;
  };
  let finished = false;
  const running = runWorkerOnce(
    f.connect,
    async () => {
      f.calls.push("maintain");
      started.resolve();
      await transaction.promise;
    },
    f.options,
  ).then((result) => {
    finished = true;
    return result;
  });
  await started.promise;
  for (const signal of ["SIGTERM", "SIGTERM", "SIGINT"]) f.signals.emit(signal);
  assert.deepEqual(f.calls, ["connect", "maintain", "drain"]);
  assert.equal(finished, false);
  transaction.resolve();
  await closing.promise;
  f.signals.emit("SIGINT");
  assert.equal(finished, false);
  closed.resolve();
  assert.equal(await running, "completed");
  assert.deepEqual(f.calls, ["connect", "maintain", "drain", "close"]);
  detached(f.signals);
});

test("stop while connecting prevents admission, but still closes the connection", async () => {
  const f = fixture(),
    connecting = deferred<Database>();
  const running = runWorkerOnce(
    () => connecting.promise,
    f.maintain,
    f.options,
  );
  f.signals.emit("SIGTERM");
  connecting.resolve(f.db);
  assert.equal(await running, "skipped");
  assert.deepEqual(f.calls, ["drain", "close"]);
  detached(f.signals);
});

for (const stage of ["connect", "maintain", "close"] as const) {
  test(`${stage} failure is not success and never exposes driver errors`, async () => {
    const f = fixture();
    const fail = async () => {
      throw new Error("private-db-url-and-query");
    };
    if (stage === "connect") f.connect = fail;
    if (stage === "maintain") f.maintain = fail;
    if (stage === "close") f.db.close = fail;
    await assert.rejects(runWorkerOnce(f.connect, f.maintain, f.options), {
      message: "Worker maintenance failed",
    });
    assert.equal(f.calls.filter((x) => x === "maintain").length <= 1, true);
    if (stage === "maintain") assert.equal(f.calls.at(-1), "close");
    detached(f.signals);
  });
  test(`shutdown deadline includes hung ${stage}, without early close or success`, async () => {
    const f = fixture(),
      reached = deferred();
    const hang = async () => {
      reached.resolve();
      return new Promise<never>(() => {});
    };
    if (stage === "connect") f.connect = hang;
    if (stage === "maintain") f.maintain = hang;
    if (stage === "close") f.db.close = hang;
    const running = runWorkerOnce(f.connect, f.maintain, {
      ...f.options,
      shutdownMs: 15,
    });
    const rejection = assert.rejects(running, {
      message: "Worker maintenance failed",
    });
    await reached.promise;
    f.signals.emit("SIGTERM");
    f.signals.emit("SIGINT");
    await rejection;
    assert.equal(f.calls.filter((x) => x === "drain").length, 1);
    assert.equal(f.calls.includes("close"), false);
    detached(f.signals);
  });
}

test("transaction failure during drain remains failure after successful close", async () => {
  const f = fixture(),
    started = deferred(),
    transaction = deferred();
  const running = runWorkerOnce(
    f.connect,
    async () => {
      started.resolve();
      await transaction.promise;
    },
    f.options,
  );
  const rejection = assert.rejects(running, {
    message: "Worker maintenance failed",
  });
  await started.promise;
  f.signals.emit("SIGTERM");
  transaction.reject(new Error("private-driver-error"));
  await rejection;
  assert.deepEqual(f.calls, ["connect", "drain", "close"]);
  detached(f.signals);
});

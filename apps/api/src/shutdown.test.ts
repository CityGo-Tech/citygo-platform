import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import Fastify from "fastify";
import {
  ApiDrain,
  createShutdown,
  installShutdown,
  registerDrain,
} from "./shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("drain rejects new work synchronously and waits for both successful and failed handlers", async () => {
  const drain = new ApiDrain();
  const gate = deferred();
  const work = drain.run(async () => {
    await gate.promise;
    return 42;
  });
  const failed = drain.run(async () => {
    await gate.promise;
    throw new Error("synthetic");
  });
  const rejection = assert.rejects(failed, /synthetic/);
  assert.equal(drain.active, 2);
  let closed = 0;
  const shutdown = createShutdown(drain, async () => {
    closed++;
  });
  const done = shutdown();
  assert.equal(done, shutdown());
  await assert.rejects(
    drain.run(() => assert.fail("must not run")),
    { statusCode: 503, code: "SERVICE_UNAVAILABLE" },
  );
  assert.equal(closed, 0);
  assert.equal(drain.signal.aborted, false);
  gate.resolve();
  assert.equal(await work, 42);
  await rejection;
  await done;
  assert.equal(drain.active, 0);
  assert.equal(closed, 1);
});

test("grace expiry cancels a stream but waits for its asynchronous settlement", async () => {
  const drain = new ApiDrain();
  const cancelled = deferred();
  const persisted = deferred();
  const work = drain.run(async () => {
    drain.signal.addEventListener("abort", cancelled.resolve, { once: true });
    await cancelled.promise;
    await persisted.promise;
  });
  let closed = false;
  const done = createShutdown(
    drain,
    async () => {
      closed = true;
    },
    { graceMs: 10, cleanupMs: 1000 },
  )();
  await cancelled.promise;
  assert.equal(closed, false);
  assert.equal(drain.active, 1);
  persisted.resolve();
  await work;
  await done;
  assert.equal(closed, true);
});

test("a stuck handler or close has a bounded failure, never a false clean shutdown", async () => {
  const drain = new ApiDrain();
  const gate = deferred();
  const work = drain.run(() => gate.promise);
  let closed = false;
  const done = createShutdown(
    drain,
    async () => {
      closed = true;
    },
    { graceMs: 10, cleanupMs: 10 },
  )();
  await assert.rejects(done, /deadline exceeded/);
  assert.equal(closed, false);
  assert.equal(drain.signal.aborted, true);
  gate.resolve();
  await work;
  const closeGate = deferred();
  const stuckClose = createShutdown(new ApiDrain(), () => closeGate.promise, {
    graceMs: 10,
    cleanupMs: 10,
  });
  await assert.rejects(stuckClose(), /deadline exceeded/);
  closeGate.resolve();
  await assert.rejects(
    createShutdown(new ApiDrain(), async () => {
      throw new Error("close failed");
    })(),
    /close failed/,
  );
});

test(
  "real HTTP disconnect does not release a hijacked handler before persistence",
  { timeout: 5000 },
  async (t) => {
    const app = Fastify();
    const drain = new ApiDrain();
    const disconnected = deferred();
    const persisted = deferred();
    let closed = false;
    registerDrain(app, drain);
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/ready", async () => ({ status: "ok" }));
    app.get("/v1/stream", async (_req, reply) => {
      reply.hijack();
      reply.raw.on("close", disconnected.resolve);
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.write("data: synthetic\n\n");
      await disconnected.promise;
      await persisted.promise;
      reply.raw.end();
    });
    app.addHook("onClose", async () => {
      closed = true;
    });
    t.after(async () => {
      persisted.resolve();
      await app.close();
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      const req = request(address + "/v1/stream", (res) => {
        res.once("data", () => {
          res.destroy();
          resolve();
        });
        res.on("error", () => {});
      });
      req.on("error", reject);
      req.end();
    });
    await disconnected.promise;
    const stop = createShutdown(drain, () => app.close())();
    assert.equal(drain.active, 1);
    assert.equal(closed, false);
    assert.equal((await fetch(address + "/health")).status, 200);
    assert.equal((await fetch(address + "/ready")).status, 503);
    persisted.resolve();
    await stop;
    assert.equal(closed, true);
  },
);

test("repeated OS signal notifications share one drain and remove listeners after closing", async () => {
  const app = Fastify();
  const drain = new ApiDrain();
  const gate = deferred();
  const work = drain.run(() => gate.promise);
  const closed = deferred();
  let closes = 0;
  app.addHook("onClose", async () => {
    closes++;
    closed.resolve();
  });
  const before = process.listenerCount("SIGTERM");
  const remove = installShutdown(app, drain);
  try {
    // No real process signal is sent on Windows; exercise the same listener.
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");
    await assert.rejects(
      drain.run(() => {}),
      { statusCode: 503 },
    );
    gate.resolve();
    await work;
    await closed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes, 1);
    assert.equal(process.listenerCount("SIGTERM"), before);
  } finally {
    remove();
    gate.resolve();
    await app.close();
  }
});

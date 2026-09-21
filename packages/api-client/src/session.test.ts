import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionGuard,
  createSessionStorage,
  clearSessionAndRevoke,
  createSessionLogout,
  StaleSessionError,
} from "./session.js";
import { createClient } from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("session change aborts old work and owner changes are explicit", () => {
  const session = createSessionGuard();
  const a = session.capture();
  assert.equal(session.hasOwner(), false);
  assert.equal(session.ownerChanged("A"), false);
  assert.equal(session.hasOwner(), true);
  assert.equal(session.ownerChanged("A"), false);
  assert.equal(session.ownerChanged("B"), true);
  session.reset("B");
  assert.equal(a.signal.aborted, true);
  assert.equal(a.active(), false);
  assert.throws(a.check, StaleSessionError);
  assert.equal(session.capture().active(), true);
  assert.equal(session.ownerChanged("B"), false);
  session.reset();
  assert.equal(session.hasOwner(), false);
});

test("late JSON and late 401 from A cannot expire or populate B", async (t) => {
  for (const status of [200, 401]) {
    const session = createSessionGuard();
    const pending = deferred<Response>();
    let expired = 0;
    t.mock.method(globalThis, "fetch", async () => pending.promise);
    const client = createClient("http://synthetic", {
      signal: () => session.capture().signal,
      onUnauthorized: () => {
        expired++;
      },
    });
    const request = client.dashboard();
    const rejected = assert.rejects(request, /прежней сессии/);
    session.reset("B");
    pending.resolve(Response.json({ user: { id: "A" } }, { status }));
    await rejected;
    assert.equal(expired, 0);
  }
});

test("401 on a protected mutation clears the current session even with a non-JSON error", async (t) => {
  const session = createSessionGuard();
  const ticket = session.capture();
  let expired = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("expired", { status: 401 }),
  );
  const client = createClient("http://synthetic", {
    signal: () => session.capture().signal,
    onUnauthorized: () => {
      expired++;
      session.reset();
    },
  });
  await assert.rejects(client.start("quest-A"));
  assert.equal(expired, 1);
  assert.equal(ticket.active(), false);
  await assert.rejects(
    client.auth("login", "synthetic@example.test", "wrong-password"),
  );
  assert.equal(expired, 1, "bad credentials must not expire another session");
});

test("closing a session cancels a stalled SSE body without publishing late events", async (t) => {
  const session = createSessionGuard();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            writer = controller;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const client = createClient("http://synthetic", {
    signal: () => session.capture().signal,
  });
  const received: unknown[] = [];
  const first = deferred<void>();
  const stream = client.stream("A", "synthetic", "uuid", (event) => {
    received.push(event);
    first.resolve();
  });
  const rejected = assert.rejects(stream, /прежней сессии/);
  // fetch has yielded; wait for the reader to be installed.
  await Promise.resolve();
  await Promise.resolve();
  writer.enqueue(
    new TextEncoder().encode('data: {"type":"delta","text":"A"}\n\n'),
  );
  await first.promise;
  session.reset("B");
  await rejected;
  assert.equal(cancelled, true);
  assert.deepEqual(received, [{ type: "delta", text: "A" }]);
});

test("native local logout deletes a credential after a delayed login write, even offline", async () => {
  const session = createSessionGuard();
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  let stored: string | null = null;
  const storage = createSessionStorage({
    get: async () => stored,
    set: async (token) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      stored = token;
    },
    remove: async () => {
      stored = null;
    },
  });
  const saving = storage.save("synthetic-token-A", session.capture());
  const rejected = assert.rejects(saving, StaleSessionError);
  await writeStarted.promise;
  session.reset();
  const clearing = clearSessionAndRevoke(storage, async () => {
    assert.equal(
      stored,
      null,
      "credential must be gone before network revocation",
    );
    throw new Error("offline");
  });
  releaseWrite.resolve();
  const [, result] = await Promise.all([rejected, clearing]);
  assert.equal(stored, null);
  assert.equal(result.serverRevoked, false);
});

test("native stale storage reads/writes cannot restore A, and deletion failure stays visible", async () => {
  const session = createSessionGuard();
  const read = deferred<string | null>();
  let writes = 0;
  let fail = true;
  const storage = createSessionStorage({
    get: async () => read.promise,
    set: async () => {
      writes++;
    },
    remove: async () => {
      if (fail) throw new Error("storage unavailable");
    },
  });
  const old = session.capture();
  const loading = storage.load(old);
  const rejected = assert.rejects(loading, StaleSessionError);
  await Promise.resolve();
  session.reset("B");
  read.resolve("synthetic-token-A");
  await rejected;
  await assert.rejects(
    storage.save("synthetic-token-A", old),
    StaleSessionError,
  );
  assert.equal(writes, 0);
  let revocations = 0;
  await assert.rejects(
    clearSessionAndRevoke(storage, async () => {
      revocations++;
    }),
    /storage unavailable/,
  );
  assert.equal(revocations, 0);
  fail = false;
  assert.deepEqual(
    await clearSessionAndRevoke(storage, async () => {
      revocations++;
    }),
    { serverRevoked: true },
  );
  assert.equal(revocations, 1);
});

test("native deletion retry preserves the original server revocation intent and credential", async () => {
  let failDeletion = true;
  let stored: string | null = "synthetic-token-A";
  let memoryToken: string | null = stored;
  const revoked: string[] = [];
  const attempt = createSessionLogout({
    async clear() {
      if (failDeletion) throw new Error("storage unavailable");
      stored = null;
    },
  });
  const originalToken = memoryToken;
  memoryToken = null;
  await assert.rejects(
    attempt.run(async () => {
      assert.equal(stored, null, "device credential must be removed first");
      revoked.push(originalToken);
    }),
    /storage unavailable/,
  );
  assert.equal(memoryToken, null);
  assert.deepEqual(revoked, []);
  failDeletion = false;
  // The retry UI has no token; the original intent must survive its first failure.
  const retry = attempt.run();
  const duplicate = attempt.run(async () => {
    throw new Error("must not replace the original intent");
  });
  assert.equal(
    retry,
    duplicate,
    "double tapping must share one logout attempt",
  );
  assert.deepEqual(await retry, {
    serverRevoked: true,
    revocationRequested: true,
  });
  assert.deepEqual(revoked, ["synthetic-token-A"]);
  assert.equal(stored, null);
  assert.deepEqual(await attempt.run(), {
    serverRevoked: false,
    revocationRequested: false,
  });
  assert.equal(
    revoked.length,
    1,
    "a later session must not reuse A's credential",
  );
});

test("native retry reports unconfirmed server revocation honestly after successful local deletion", async () => {
  let failDeletion = true;
  let revocations = 0;
  const attempt = createSessionLogout({
    async clear() {
      if (failDeletion) throw new Error("storage unavailable");
    },
  });
  await assert.rejects(
    attempt.run(async () => {
      revocations++;
      throw new Error("offline");
    }),
    /storage unavailable/,
  );
  failDeletion = false;
  assert.deepEqual(await attempt.run(), {
    serverRevoked: false,
    revocationRequested: true,
  });
  assert.equal(revocations, 1);
  assert.deepEqual(await attempt.run(), {
    serverRevoked: false,
    revocationRequested: false,
  });
  assert.equal(
    revocations,
    1,
    "discard the in-memory credential after local cleanup",
  );
});

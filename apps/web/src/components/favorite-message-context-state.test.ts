import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@citygo/api-client";
import type { Message } from "@citygo/contracts";
import { createFavoriteContextResource } from "./favorite-message-context-state";

const rows = (first: bigint, count: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: String(first + BigInt(index)),
    role: index % 2 ? "assistant" : "user",
    content: `Saved ${first + BigInt(index)}`,
    agentKey: "support",
    status: "complete",
    favorite: false,
  }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(total = 2500, unavailableMessage?: string) {
  const source = rows(9007199254740992n, total);
  const target = source.at(-1)!.id;
  const owner = new AbortController();
  const calls: string[] = [];
  const states: unknown[] = [];
  let denied = 0;
  const page = (before?: string) => {
    const matching = before
      ? source.filter((message) => BigInt(message.id) < BigInt(before))
      : source;
    const messages = matching.slice(-100);
    return {
      userId: "10",
      threadId: "20",
      messages,
      nextCursor: matching.length > 100 ? messages[0]!.id : null,
    };
  };
  const transport = {
    context: async (): Promise<unknown> => page(),
    older: async (before: string): Promise<unknown> => page(before),
  };
  const resource = createFavoriteContextResource({
    userId: "10",
    threadId: "20",
    messageId: target,
    sessionSignal: owner.signal,
    context: (signal) => {
      assert.equal(signal.aborted, false);
      calls.push("source");
      return transport.context();
    },
    older: (before) => {
      calls.push(before);
      return transport.older(before);
    },
    publish: (state) => states.push(state),
    onAccessDenied: () => denied++,
    unavailableMessage,
  });
  return {
    source,
    target,
    owner,
    calls,
    states,
    page,
    transport,
    resource,
    denied: () => denied,
  };
}

test("the same owned non-favorite source resource can report a plan-specific unavailable message", async () => {
  const s = setup(2, "Исходное сообщение недоступно. Вернитесь к плану.");
  s.transport.context = async () => {
    throw new ApiError(404, "Missing");
  };
  await s.resource.loadSource();
  assert.equal(
    s.resource.snapshot().error,
    "Исходное сообщение недоступно. Вернитесь к плану.",
  );
  assert.deepEqual(s.resource.snapshot().messages, []);
  assert.equal(s.denied(), 0);
  assert.equal(s.source.at(-1)!.favorite, false);
});

test("source history has no automatic reads; one explicit GET finds exact bigint target and earlier pages", async () => {
  const s = setup(250);
  assert.deepEqual(s.calls, []);
  await s.resource.loadSource();
  assert.equal(s.resource.snapshot().messages.at(-1)?.id, s.target);
  assert.equal(s.resource.snapshot().messages.length, 100);
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  await s.resource.loadOlder();
  assert.equal(s.calls.length, 3);
  assert.deepEqual(s.resource.snapshot().messages, s.source);
  assert.equal(s.resource.snapshot().nextCursor, null);
  s.resource.dispose();
});

test("a full window retains an honest contiguous older range and explicitly reloads the selected source", async () => {
  const s = setup(2500);
  await s.resource.loadSource();
  for (let index = 0; index < 15; index++) await s.resource.loadOlder();
  const window = s.resource.snapshot();
  assert.equal(window.messages.length, 1000);
  assert.equal(window.trimmed, true);
  assert.deepEqual(window.messages, s.source.slice(900, 1900));
  assert.equal(window.nextCursor, window.messages[0]!.id);
  assert.ok(window.messages.every((message) => message.id !== s.target));
  await s.resource.loadSource();
  assert.equal(s.resource.snapshot().trimmed, false);
  assert.equal(s.resource.snapshot().messages.at(-1)?.id, s.target);
  s.resource.dispose();
});

test("duplicate clicks make one GET and disposed late data is discarded", async () => {
  const s = setup();
  const gate = deferred<unknown>();
  s.transport.context = () => gate.promise;
  const pending = s.resource.loadSource();
  await s.resource.loadSource();
  assert.deepEqual(s.calls, ["source"]);
  s.resource.dispose();
  const count = s.states.length;
  gate.resolve(s.page());
  await pending;
  assert.equal(s.states.length, count);
  assert.deepEqual(s.resource.snapshot().messages, []);
});

test("logout clears previously loaded data and rejects an older page resolving afterwards", async () => {
  const s = setup();
  await s.resource.loadSource();
  const gate = deferred<unknown>();
  s.transport.older = () => gate.promise;
  const before = s.resource.snapshot().nextCursor!;
  const pending = s.resource.loadOlder();
  s.owner.abort();
  const count = s.states.length;
  gate.resolve(s.page(before));
  await pending;
  assert.equal(s.states.length, count);
  assert.equal(s.resource.snapshot().phase, "closed");
  assert.deepEqual(s.resource.snapshot().messages, []);
});

test("owner/thread/target mismatch never becomes visible and retry is explicit", async () => {
  for (const corrupt of [
    { userId: "11" },
    { threadId: "21" },
    { messages: rows(1n, 5), nextCursor: null },
  ]) {
    const s = setup();
    s.transport.context = async () => ({ ...s.page(), ...corrupt });
    await s.resource.loadSource();
    assert.equal(s.resource.snapshot().phase, "error");
    assert.deepEqual(s.resource.snapshot().messages, []);
    assert.deepEqual(s.calls, ["source"]);
    s.transport.context = async () => s.page();
    await s.resource.retry();
    assert.equal(s.resource.snapshot().phase, "ready");
    assert.equal(s.calls.length, 2);
    s.resource.dispose();
  }
});

test("a failed older page preserves the source; retry cannot append overlapping or newer messages", async () => {
  const s = setup();
  await s.resource.loadSource();
  const messages = s.resource.snapshot().messages;
  s.transport.older = async () => {
    throw new Error("offline");
  };
  await s.resource.loadOlder();
  assert.deepEqual(s.resource.snapshot().messages, messages);
  const before = s.resource.snapshot().nextCursor!;
  s.transport.older = async () => s.page();
  await s.resource.retry();
  assert.equal(s.resource.snapshot().phase, "error");
  assert.deepEqual(s.resource.snapshot().messages, messages);
  s.transport.older = async () => s.page(before);
  await s.resource.retry();
  assert.equal(s.resource.snapshot().phase, "ready");
  assert.equal(s.resource.snapshot().messages.length, 200);
  s.resource.dispose();
});

test("401/403 clear data and call the session guard once; 404 is a recoverable unavailable source", async () => {
  for (const status of [401, 403, 404]) {
    const s = setup();
    s.transport.context = async () => {
      throw new ApiError(status, "no access");
    };
    await s.resource.loadSource();
    assert.deepEqual(s.resource.snapshot().messages, []);
    assert.equal(s.denied(), status === 404 ? 0 : 1);
    assert.equal(
      s.resource.snapshot().phase,
      status === 404 ? "error" : "closed",
    );
    if (status === 404) assert.match(s.resource.snapshot().error, /недоступно/);
    else {
      await s.resource.loadSource();
      assert.equal(s.denied(), 1);
    }
    s.resource.dispose();
  }
});

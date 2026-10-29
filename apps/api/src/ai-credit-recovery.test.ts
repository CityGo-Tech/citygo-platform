import assert from "node:assert/strict";
import test from "node:test";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { DomainError } from "@citygo/db";
import {
  observeChatClientDisconnect,
  recoverCompletedChatCharge,
} from "./ai-credit-recovery.js";

const holdId = "11111111-1111-4111-8111-111111111111";
const completed = { holdId, responseComplete: true, generationPresent: true };
const unavailable = (error: unknown) =>
  error instanceof DomainError &&
  error.statusCode === 409 &&
  error.code === "AI_CREDIT_UNAVAILABLE";

test("explicit recovery makes at most one owned completed lookup and never revisits ambiguous or interrupted holds", async () => {
  const calls: string[] = [];
  let reports = 0;
  const options = {
    signal: new AbortController().signal,
    reconcile: async (id: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      calls.push(id);
    },
    reportPending: () => reports++,
  };
  await recoverCompletedChatCharge({ ...options, charges: [] });
  await recoverCompletedChatCharge({ ...options, charges: [completed] });
  assert.deepEqual(calls, [holdId]);
  for (const charges of [
    [{ ...completed, responseComplete: false }],
    [{ ...completed, responseComplete: null }],
    [{ ...completed, generationPresent: false }],
    [completed, completed],
  ])
    await assert.rejects(
      recoverCompletedChatCharge({ ...options, charges }),
      unavailable,
    );
  assert.deepEqual(calls, [holdId]);
  assert.equal(reports, 0);
});

test("failed lookup reports no raw error and never silently permits a question", async () => {
  let reports = 0;
  await assert.rejects(
    recoverCompletedChatCharge({
      charges: [completed],
      signal: new AbortController().signal,
      reconcile: async () => {
        throw new Error("PRIVATE upstream credential or response");
      },
      reportPending: () => reports++,
    }),
    unavailable,
  );
  assert.equal(reports, 1);
});

test("recovery observes existing drain cancellation before dispatch and while GET is pending", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    recoverCompletedChatCharge({
      charges: [completed],
      signal: controller.signal,
      reconcile: async () => {
        calls++;
      },
      reportPending: () => {},
    }),
    unavailable,
  );
  assert.equal(calls, 0);
  const later = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const promise = recoverCompletedChatCharge({
    charges: [completed],
    signal: later.signal,
    reconcile: async (_id, signal) =>
      new Promise<void>((_resolve, reject) => {
        assert.notEqual(signal, later.signal);
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        entered();
      }),
    reportPending: () => {},
  });
  await started;
  later.abort();
  await assert.rejects(promise, unavailable);
});

test("disconnect during cost recovery aborts the pending GET before any new question admission and removes temporary listeners", async () => {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);
  const disconnect = observeChatClientDisconnect(request, response);
  let admitted = false;
  let providerGets = 0;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const recovery = (async () => {
    await recoverCompletedChatCharge({
      charges: [completed],
      signal: disconnect.abort.signal,
      reconcile: async (_holdId, signal) =>
        new Promise<void>((_resolve, reject) => {
          providerGets++;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          started();
        }),
      reportPending: () => {},
    });
    disconnect.abort.signal.throwIfAborted();
    admitted = true;
  })();
  await entered;
  // The request body closing normally must not cancel the response.
  request.emit("close");
  assert.equal(disconnect.abort.signal.aborted, false);
  response.emit("close");
  await assert.rejects(recovery, unavailable);
  assert.equal(providerGets, 1);
  assert.equal(admitted, false);
  disconnect.dispose();
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("pre-admission disconnect observer catches an already aborted request and a later request abort", () => {
  const request = new IncomingMessage(new Socket());
  const response = new ServerResponse(request);
  const first = observeChatClientDisconnect(request, response);
  request.emit("aborted");
  assert.equal(first.abort.signal.aborted, true);
  first.dispose();
  request.aborted = true;
  const second = observeChatClientDisconnect(request, response);
  assert.equal(second.abort.signal.aborted, true);
  second.dispose();
});

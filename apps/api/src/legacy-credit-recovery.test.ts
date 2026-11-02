import assert from "node:assert/strict";
import test from "node:test";
import { LegacyCompletedChargeRecovery } from "./ai-credit-recovery.js";

type Charge = { holdId: string; userId: string };
const charge = (n: number): Charge => ({
  holdId: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
  userId: String(n),
});
const signal = () => new AbortController().signal;
const empty = { processed: 0, retained: 0 };
const success = { processed: 1, retained: 0 };
const retained = { processed: 0, retained: 1 };
const keyset = (rows: Charge[], after: string | undefined, limit: number) =>
  rows
    .filter((row) => after === undefined || row.holdId > after)
    .slice(0, limit);

test("legacy recovery limits each batch to one callback and advances its UUID cursor", async () => {
  const rows = Array.from({ length: 45 }, (_, i) => charge(i + 1));
  const scans: { after: string | undefined; limit: number }[] = [];
  const calls: Charge[] = [];
  const lane = new LegacyCompletedChargeRecovery({
    list: async (after, limit) => {
      scans.push({ after, limit });
      return keyset(rows, after, limit);
    },
    reconcile: async (row) => {
      calls.push(row);
      return true;
    },
  });
  assert.deepEqual(await lane.run(signal()), success);
  assert.deepEqual(calls, [rows[0]]);
  assert.deepEqual(await lane.run(signal()), success);
  assert.deepEqual(calls, [rows[0], rows[1]]);
  assert.deepEqual(scans, [
    { after: undefined, limit: 20 },
    { after: rows[0]!.holdId, limit: 20 },
  ]);
});

test("a backoff row cannot starve a later charge after the cursor wraps", async () => {
  let rows = [charge(1), charge(2)];
  const calls: string[] = [];
  const lane = new LegacyCompletedChargeRecovery({
    now: () => 1_700_000_000_000,
    list: async (after, limit) => keyset(rows, after, limit),
    reconcile: async (row) => {
      calls.push(row.holdId);
      if (row.holdId === charge(1).holdId) return false;
      rows = rows.filter((candidate) => candidate.holdId !== row.holdId);
      return true;
    },
  });
  assert.deepEqual(await lane.run(signal()), retained);
  assert.deepEqual(await lane.run(signal()), success);
  assert.deepEqual(await lane.run(signal()), empty);
  rows.push(charge(3));
  assert.deepEqual(await lane.run(signal()), success);
  assert.deepEqual(calls, [
    charge(1).holdId,
    charge(2).holdId,
    charge(3).holdId,
  ]);
});

test("an empty page resets the cursor so a newly completed earlier UUID is visited", async () => {
  let rows = [charge(20)];
  const calls: string[] = [];
  const lane = new LegacyCompletedChargeRecovery({
    list: async (after, limit) => keyset(rows, after, limit),
    reconcile: async (row) => {
      calls.push(row.holdId);
      rows = [];
      return true;
    },
  });
  assert.deepEqual(await lane.run(signal()), success);
  assert.deepEqual(await lane.run(signal()), empty);
  rows = [charge(1)];
  assert.deepEqual(await lane.run(signal()), success);
  assert.deepEqual(calls, [charge(20).holdId, charge(1).holdId]);
});

test("unknown receipts back off from sixty seconds exponentially and stay capped at six hours", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const row = charge(1);
  const lane = new LegacyCompletedChargeRecovery({
    now: () => now,
    list: async (after, limit) => keyset([row], after, limit),
    reconcile: async () => {
      calls++;
      return false;
    },
  });
  const attempt = async () => {
    const before = calls;
    for (let i = 0; i < 3; i++) {
      const result = await lane.run(signal());
      if (calls !== before) {
        assert.equal(calls, before + 1);
        assert.deepEqual(result, retained);
        return;
      }
      assert.deepEqual(result, empty);
    }
    assert.fail("an eligible receipt was starved across a full cursor cycle");
  };
  await attempt();
  for (let failure = 1; failure <= 12; failure++) {
    const delay = Math.min(60_000 * 2 ** (failure - 1), 6 * 60 * 60 * 1000);
    now += delay - 1;
    const before = calls;
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await lane.run(signal()), empty);
    assert.equal(
      calls,
      before,
      "a GET was dispatched before its backoff expired",
    );
    now++;
    await attempt();
  }
  assert.equal(calls, 13);
});

test("a successful resolution removes prior failure history instead of extending the next backoff", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const outcomes = [false, true, false, true];
  const lane = new LegacyCompletedChargeRecovery({
    now: () => now,
    list: async (after, limit) => keyset([charge(1)], after, limit),
    reconcile: async () => outcomes[calls++]!,
  });
  const attempt = async () => {
    const before = calls;
    for (let i = 0; i < 3; i++) {
      const result = await lane.run(signal());
      if (calls !== before) return result;
      assert.deepEqual(result, empty);
    }
    assert.fail("an eligible receipt was not revisited");
  };
  assert.deepEqual(await attempt(), retained);
  now += 60_000;
  assert.deepEqual(await attempt(), success);
  assert.deepEqual(await attempt(), retained);
  now += 60_000;
  assert.deepEqual(await attempt(), success);
  assert.equal(calls, 4);
});

test("callback errors retain the receipt without logging private provider data", async (t) => {
  const logs: unknown[][] = [];
  let calls = 0;
  for (const method of ["log", "warn", "error"] as const)
    t.mock.method(console, method, (...args: unknown[]) => logs.push(args));
  const lane = new LegacyCompletedChargeRecovery({
    list: async () => [charge(1), charge(2)],
    reconcile: async () => {
      calls++;
      throw new Error("PRIVATE provider response or credential");
    },
  });
  assert.deepEqual(await lane.run(signal()), retained);
  assert.equal(calls, 1);
  assert.deepEqual(logs, []);
});

test("an already aborted drain never lists charges or dispatches a callback", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic drain");
  controller.abort(reason);
  let listed = 0;
  let calls = 0;
  const lane = new LegacyCompletedChargeRecovery({
    list: async () => {
      listed++;
      return [charge(1)];
    },
    reconcile: async () => {
      calls++;
      return true;
    },
  });
  await assert.rejects(
    lane.run(controller.signal),
    (error) => error === reason,
  );
  assert.equal(listed, 0);
  assert.equal(calls, 0);
});

test("a drain during listing ignores late rows before any provider callback", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic drain");
  let deliver!: (rows: Charge[]) => void;
  let calls = 0;
  const lane = new LegacyCompletedChargeRecovery({
    list: async () => new Promise<Charge[]>((resolve) => (deliver = resolve)),
    reconcile: async () => {
      calls++;
      return true;
    },
  });
  const pending = lane.run(controller.signal);
  controller.abort(reason);
  deliver([charge(1)]);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 0);
});

test("a drain aborts the combined callback signal and waits for actual callback completion", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic drain");
  let finish!: (settled: boolean) => void;
  let callbackSignal!: AbortSignal;
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const lane = new LegacyCompletedChargeRecovery({
    list: async () => [charge(1), charge(2)],
    reconcile: async (_row, current) => {
      calls++;
      callbackSignal = current;
      entered();
      return new Promise<boolean>((resolve) => (finish = resolve));
    },
  });
  const pending = lane.run(controller.signal);
  let drained = false;
  void pending.then(
    () => (drained = true),
    () => (drained = true),
  );
  await started;
  assert.notEqual(callbackSignal, controller.signal);
  controller.abort(reason);
  assert.equal(callbackSignal.aborted, true);
  await Promise.resolve();
  assert.equal(drained, false, "abort must not fabricate callback completion");
  finish(true);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(calls, 1);
});

test("the independent five-second deadline cancels the GET without completing a user charge", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 5000);
    return deadline.signal;
  });
  const parent = new AbortController();
  let entered!: () => void;
  let callbackSignal!: AbortSignal;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const lane = new LegacyCompletedChargeRecovery({
    list: async () => [charge(1), charge(2)],
    reconcile: async (_row, current) => {
      callbackSignal = current;
      return new Promise<boolean>((_resolve, reject) => {
        current.addEventListener("abort", () => reject(current.reason), {
          once: true,
        });
        entered();
      });
    },
  });
  const pending = lane.run(parent.signal);
  await started;
  deadline.abort(new DOMException("synthetic deadline", "TimeoutError"));
  assert.equal(callbackSignal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.deepEqual(await pending, retained);
});

test("more than 256 retained rows cannot grow an unbounded permanent retry cache", async () => {
  const rows = Array.from({ length: 257 }, (_, i) => charge(i + 1));
  let calls = 0;
  const lane = new LegacyCompletedChargeRecovery({
    now: () => 1_700_000_000_000,
    list: async (after, limit) => keyset(rows, after, limit),
    reconcile: async () => {
      calls++;
      return false;
    },
  });
  for (let i = 0; i < rows.length; i++)
    assert.deepEqual(await lane.run(signal()), retained);
  assert.equal(calls, 257);
  const before = calls;
  for (let i = 0; i < 15 && calls === before; i++) {
    const result = await lane.run(signal());
    assert.ok(result.processed + result.retained <= 1);
  }
  assert.equal(
    calls,
    before + 1,
    "at least one excess retry entry must be evicted",
  );
});

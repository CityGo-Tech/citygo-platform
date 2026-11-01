import assert from "node:assert/strict";
import test from "node:test";
import {
  balanceHistoryPageSchema,
  balanceHistoryQuerySchema,
  compareBalanceHistoryEntries,
  type BalanceHistoryEntry,
} from "./balance-history.js";
const entry = (id = "credit:9007199254740993"): BalanceHistoryEntry => ({
  id,
  kind: "spend",
  direction: "debit",
  amountMicros: 3_750_001,
  createdAt: "2026-11-01T12:00:00.000001Z",
});
test("balance history preserves exact micro-units and bigint IDs, requires correct direction and descending unique rows", () => {
  const page = {
    userId: "1",
    filter: "all",
    entries: [entry(), entry("credit:9007199254740992")],
    nextCursor: null,
  };
  assert.equal(
    balanceHistoryPageSchema.parse(page).entries[0]!.amountMicros,
    3_750_001,
  );
  assert.ok(
    compareBalanceHistoryEntries(entry("credit:10"), entry("credit:9")) < 0,
  );
  for (const entries of [
    [{ ...entry(), id: "corrupted" }, entry()],
    [{ ...entry(), id: "credit:nope" }, entry()],
    [entry(), entry()],
    [entry("credit:1"), entry("credit:2")],
    [{ ...entry(), direction: "credit" }],
    [{ ...entry(), amountMicros: 0.5 }],
    [{ ...entry(), id: "credit:9223372036854775808" }],
    [{ ...entry(), kind: "refund" }],
  ])
    assert.equal(
      balanceHistoryPageSchema.safeParse({ ...page, entries }).success,
      false,
    );
  assert.equal(
    balanceHistoryPageSchema.safeParse({ ...page, filter: "gift" }).success,
    false,
  );
  assert.equal(
    balanceHistoryPageSchema.safeParse({
      ...page,
      entries: Array.from({ length: 21 }, (_, i) =>
        entry("credit:" + (100 - i)),
      ),
    }).success,
    false,
  );
});
test("history queries reject owner injection, unbounded limits and malformed cursors", () => {
  for (const input of [
    { userId: "2" },
    { limit: "100000" },
    { filter: "hold" },
    { cursor: "x" },
    { cursor: "a".repeat(701) },
  ])
    assert.equal(balanceHistoryQuerySchema.safeParse(input).success, false);
  assert.deepEqual(balanceHistoryQuerySchema.parse({ filter: "spend" }), {
    filter: "spend",
  });
});

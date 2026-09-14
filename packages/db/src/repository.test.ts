import test from "node:test";
import assert from "node:assert/strict";
import type { Database } from "./index.js";
import { Repository } from "./repository.js";

test("chat leases reject unbounded durations before any database mutation", async () => {
  let transactions = 0;
  const db: Database = {
    async transaction() {
      transactions++;
      throw new Error("Unexpected transaction");
    },
    async query() {
      return { rows: [] };
    },
    async exec() {},
    async close() {},
  };
  const repo = new Repository(db);
  for (const leaseMs of [0, 89999, 270001, 90000.5, NaN, Infinity]) {
    await assert.rejects(
      repo.reserveChat("1", "1", "request", "test", {
        policyId: "test",
        revision: 1,
        userDailyLimit: 20,
        globalDailyLimit: 200,
        leaseMs,
      }),
      /срок блокировки/,
    );
  }
  assert.equal(transactions, 0);
});

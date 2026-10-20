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

test("chat failure reasons reject model, completed and charged states before a transaction", async () => {
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
  type FinishTail =
    Parameters<Repository["finishChat"]> extends [
      string,
      string,
      string,
      unknown,
      string,
      ...infer Tail,
    ]
      ? Tail
      : never;
  const invalid: FinishTail[] = [
    [true, false, undefined, undefined, "AI_CREDIT_EXHAUSTED"],
    [false, true, undefined, undefined, "AI_CREDIT_EXHAUSTED"],
    [
      false,
      false,
      { provider: "routerai", requestedModel: "test/model" },
      undefined,
      "AI_CREDIT_EXHAUSTED",
    ],
    [false, false, undefined, "synthetic-hold", "AI_CREDIT_EXHAUSTED"],
    // A runtime caller outside TypeScript must not create an arbitrary reason.
    [false, false, undefined, undefined, "STREAM_INTERRUPTED" as never],
  ];
  for (const tail of invalid)
    await assert.rejects(
      repo.finishChat("1", "request", "lease", "housing", "refused", ...tail),
      /Причина отказа допустима только до отправки запроса ИИ/,
    );
  assert.equal(transactions, 0);
});

test("confirmed credit refusal persists system metadata without mutating charge completion", async () => {
  const queries: string[] = [];
  let metadata: unknown;
  const db: Database = {
    async transaction(work) {
      return work(this);
    },
    async query<T>(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql.startsWith("select id from agent_threads"))
        return { rows: [{ id: "1" }] as T[] };
      if (sql.startsWith("select exists(select 1 from ai_model_attempts"))
        return { rows: [{ attempted: false }] as T[] };
      if (sql.startsWith("insert into messages")) {
        metadata = JSON.parse(String(params![2]));
        return { rows: [{ id: "2" }] as T[] };
      }
      return { rows: [] };
    },
    async exec() {},
    async close() {},
  };
  const id = await new Repository(db).finishChat(
    "1",
    "request",
    "lease",
    "housing",
    "Недостаточно средств. Запрос не отправлен ИИ.",
    false,
    false,
    undefined,
    undefined,
    "AI_CREDIT_EXHAUSTED",
  );
  assert.equal(id, "2");
  assert.deepEqual(metadata, {
    agentKey: "housing",
    status: "interrupted",
    source: "system",
    failureCode: "AI_CREDIT_EXHAUSTED",
  });
  assert.equal(
    queries.some((sql) => sql.includes("ai_credit_charges")),
    false,
  );
  assert.equal(
    queries.filter((sql) => sql.startsWith("select id from agent_threads"))
      .length,
    1,
    "the existing lease ownership guard is still used",
  );
});

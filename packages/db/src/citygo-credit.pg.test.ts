import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AiCreditLedger } from "./ai-credit.js";
import {
  connectDatabase,
  migrate,
  Repository,
  type Database,
} from "./index.js";

// Opt-in only: a caller supplies a deliberately disposable synthetic PostgreSQL.
// No .env lookup, application connection string, provider or payment API is used.
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl && !/^postgres(?:ql)?:\/\//.test(testUrl))
  throw new Error("Invalid synthetic PostgreSQL test URL");

async function fixture() {
  const admin = await connectDatabase(testUrl!);
  const schema = "citygo_credit_" + randomUUID().replaceAll("-", "");
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(testUrl!);
  scoped.searchParams.set("options", "-c search_path=" + schema);
  const db = await connectDatabase(scoped.toString());
  await migrate(db);
  const repo = new Repository(db);
  const user = await repo.register(
    "synthetic-credit@example.test",
    "SYNTHETIC-HASH",
  );
  const other = await repo.register(
    "synthetic-other@example.test",
    "SYNTHETIC-HASH",
  );
  return {
    db,
    user,
    other,
    ledger: new AiCreditLedger(db),
    close: async () => {
      await db.close();
      // The only drop target is this fresh, generated, validated test schema.
      assert.match(schema, /^citygo_credit_[a-f0-9]{32}$/);
      await admin.query(`drop schema "${schema}" cascade`);
      await admin.close();
    },
  };
}
const payment = (providerPaymentId = randomUUID()) => ({
  providerPaymentId,
  paidKopeks: 10_000,
  merchantId: "synthetic-shop",
  test: false,
  verifiedAt: "2026-10-18T00:00:00.000Z",
  verification: "server_get_succeeded" as const,
  currency: "RUB" as const,
});

test(
  "PostgreSQL: concurrent repeated payment posts once, competing owners cannot steal it",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const proof = payment(),
      operation = randomUUID();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        f.ledger.topUpConfirmed(f.user, operation, proof),
      ),
    );
    const collision = payment();
    const results = await Promise.allSettled([
      f.ledger.topUpConfirmed(f.user, randomUUID(), collision),
      f.ledger.topUpConfirmed(f.other, randomUUID(), collision),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      (await f.db.query("select * from ai_credit_topups")).rows.length,
      2,
    );
    assert.equal(
      (await f.db.query("select * from ai_credit_entries")).rows.length,
      2,
    );
    const total = await f.db.query<{ granted: string }>(
      "select sum(granted_micros)::text as granted from ai_credit_accounts",
    );
    assert.equal(total.rows[0]!.granted, "200000000");
  },
);

test(
  "PostgreSQL: top-up and competing holds serialize with exact final balance",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    await f.ledger.topUpConfirmed(f.user, randomUUID(), payment());
    const results = await Promise.allSettled([
      f.ledger.hold(f.user, randomUUID(), 80_000_000),
      f.ledger.hold(f.user, randomUUID(), 80_000_000),
      f.ledger.topUpConfirmed(f.user, randomUUID(), payment()),
    ]);
    assert.equal(results[2]!.status, "fulfilled");
    const state = await f.ledger.status(f.user);
    assert.equal(state.grantedMicros, 200_000_000);
    assert.ok([80_000_000, 160_000_000].includes(state.heldMicros));
    assert.equal(state.availableMicros, state.grantedMicros - state.heldMicros);
  },
);

test(
  "PostgreSQL: failure after top-up entry rolls back total and immutable receipt",
  { skip: !testUrl },
  async (t) => {
    const f = await fixture();
    t.after(f.close);
    const broken: Database = {
      ...f.db,
      transaction: (work) =>
        f.db.transaction((tx) =>
          work({
            ...tx,
            query: async <T>(sql: string, params?: unknown[]) => {
              if (sql.includes("insert into ai_credit_topups"))
                throw new Error("synthetic receipt failure");
              return tx.query<T>(sql, params);
            },
          }),
        ),
    };
    await assert.rejects(
      new AiCreditLedger(broken).topUpConfirmed(
        f.user,
        randomUUID(),
        payment(),
      ),
      /synthetic receipt failure/,
    );
    assert.equal((await f.ledger.status(f.user)).grantedMicros, 0);
    assert.equal(
      (await f.db.query("select * from ai_credit_entries")).rows.length,
      0,
    );
    assert.equal(
      (await f.db.query("select * from ai_credit_topups")).rows.length,
      0,
    );
  },
);

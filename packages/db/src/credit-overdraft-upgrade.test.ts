import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  CITYGO_10X_TARIFF,
  citygoDebitFromRealCostRub,
  routerAiCostMicros,
  type RouterAiCharge,
} from "@citygo/contracts";
import { AiCreditCharges } from "./ai-credit-charges.js";
import { AiCreditLedger } from "./ai-credit.js";
import { DomainError } from "./errors.js";
import { connectDatabase, migrate, type Database } from "./index.js";

const MODEL = "deepseek/deepseek-v4-pro-0813";
const POLICY = "a".repeat(64);
const directory = new URL("../migrations/", import.meta.url);

async function fixture(t: TestContext) {
  const database = "credit_upgrade_test_" + randomUUID().replaceAll("-", "");
  assert.match(database, /^credit_upgrade_test_[a-f0-9]{32}$/);
  let admin: Database | undefined,
    created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of [
      async () => cleanup.db?.close(),
      async () => {
        if (created) await admin!.query(`drop database "${database}"`);
      },
      async () => admin?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Synthetic credit upgrade cleanup failed",
      );
  });
  let url = "pglite://:memory:";
  const base = process.env.TEST_DATABASE_URL;
  if (base) {
    let scoped: URL;
    try {
      scoped = new URL(base);
    } catch {
      throw new Error("Requires a valid disposable PostgreSQL test target");
    }
    assert.ok(["postgres:", "postgresql:"].includes(scoped.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(scoped.hostname));
    assert.ok(
      ((scoped.port || "5432") === "5432" &&
        scoped.pathname === "/citygo_test") ||
        (scoped.port === "55438" && scoped.pathname === "/citygo_synthetic"),
      "Requires the disposable CI or local synthetic PostgreSQL target",
    );
    assert.equal(scoped.search, "");
    assert.equal(scoped.hash, "");
    admin = await connectDatabase(base);
    await admin.query(`create database "${database}" template template0`);
    created = true;
    scoped.pathname = "/" + database;
    url = scoped.toString();
  }
  const db = await connectDatabase(url);
  cleanup.db = db;
  const names = (await readdir(directory))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  assert.equal(names.length, 24, "Update the literal schema23 upgrade fixture");
  assert.equal(names[22], "0023_payment_receipt_snapshots.sql");
  assert.equal(names[23], "0024_ai_credit_overdraft.sql");
  await db.exec(
    "create table citygo_migration_lock(id integer primary key); insert into citygo_migration_lock values(1); create table citygo_migrations(name text primary key,checksum text not null,applied_at timestamptz not null default now())",
  );
  // Apply the actual first23 canonical SQL files. Never rewrite source files,
  // remove current schema objects, forge checksums or call new ledger code here.
  for (const name of names.slice(0, 23)) {
    const source = await readFile(new URL(name, directory), "utf8");
    const checksum = createHash("sha256")
      .update(source.replaceAll("\r\n", "\n"))
      .digest("hex");
    await db.transaction(async (tx) => {
      await tx.exec(
        source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
      );
      await tx.query(
        "insert into citygo_migrations(name,checksum,applied_at) values($1,$2,'2026-10-19T00:00:00Z')",
        [name, checksum],
      );
    });
  }
  return db;
}

const snapshotTables = [
  ["users", "id"],
  ["user_credentials", "user_id"],
  ["sessions", "token_hash"],
  ["agent_threads", "id"],
  ["messages", "id"],
  ["chat_requests", "thread_id,request_id"],
  ["ai_model_attempts", "thread_id,request_id,attempt_number"],
  ["ai_model_attempt_daily", "usage_day"],
  ["ai_user_model_attempt_daily", "user_id,usage_day"],
  ["ai_budget", "id"],
  ["ai_budget_daily", "usage_day"],
  ["ai_credit_accounts", "user_id"],
  ["ai_credit_entries", "id"],
  ["ai_credit_topups", "operation_id"],
  ["credit_source_lots", "source_entry_id,id"],
  ["credit_hold_allocations", "hold_id,ordinal"],
  ["payment_topup_orders", "id"],
  ["npd_receipt_tasks", "id"],
  ["account_security_state", "id"],
  ["payment_admission", "id"],
] as const;
async function history(db: Database) {
  const snapshot: Record<string, unknown[]> = {};
  for (const [table, order] of snapshotTables)
    snapshot[table] = (
      await db.query<{ row: unknown }>(
        `select row_to_json(t) as row from ${table} t order by ${order}`,
      )
    ).rows.map(({ row }) => row);
  snapshot.ai_credit_charges = (
    await db.query<{ row: unknown }>(
      "select to_jsonb(c)-'reservation_mode' as row from ai_credit_charges c order by thread_id,request_id,attempt_number",
    )
  ).rows.map(({ row }) => row);
  return snapshot;
}
async function journal(db: Database) {
  return (
    await db.query<{ row: { name: string } }>(
      'select row_to_json(t) as row from citygo_migrations t order by name collate "C"',
    )
  ).rows.map(({ row }) => row);
}
async function rawBalance(db: Database, userId: string) {
  return (
    await db.query<{
      granted: string;
      spent: string;
      held: string;
      available: string;
    }>(
      "select granted_micros::text as granted,spent_micros::text as spent,held_micros::text as held,(granted_micros-held_micros-spent_micros)::text as available from ai_credit_accounts where user_id=$1",
      [userId],
    )
  ).rows[0]!;
}
function receipt(
  holdId: string,
  generationId: string,
  costRub: string,
): RouterAiCharge {
  return {
    reference: holdId,
    generationId,
    model: MODEL,
    upstream: "deepseek",
    currency: "RUB",
    costRub,
    amountMicros: routerAiCostMicros(costRub),
  };
}
async function seed23(db: Database) {
  const userId = (
    await db.query<{ id: string }>(
      "insert into users(auth_subject,username) values('synthetic-credit-upgrade','synthetic-upgrade') returning id::text",
    )
  ).rows[0]!.id;
  await db.query(
    "insert into user_credentials(user_id,email,password_hash) values($1,'credit-upgrade@example.test','synthetic-not-a-real-password-hash')",
    [userId],
  );
  await db.query(
    "insert into sessions(token_hash,user_id,expires_at) values(repeat('c',64),$1,'2099-01-01')",
    [userId],
  );
  const threadId = (
    await db.query<{ id: string }>(
      "insert into agent_threads(user_id,agent_key) values($1,'housing') returning id::text",
      [userId],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into messages(thread_id,role,content,metadata) select $1,case when n%2=1 then 'user' else 'assistant' end,'Synthetic pre-upgrade message '||n::text,jsonb_build_object('status','complete','source','model') from generate_series(1,14) n order by n",
    [threadId],
  );
  const topup = randomUUID(),
    providerPayment = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      "insert into ai_credit_accounts(user_id,granted_micros) values($1,100000000)",
      [userId],
    );
    await tx.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values($1,$2,'topup',100000000)",
      [userId, topup],
    );
    await tx.query(
      `insert into ai_credit_topups(provider_payment_id,operation_id,user_id,paid_kopeks,credited_micros,merchant_id,test,verified_at,verification_receipt)
       values($1,$2,$3,10000,100000000,'synthetic-shop',false,'2026-10-20T00:00:00Z',$4)`,
      [
        providerPayment,
        topup,
        userId,
        JSON.stringify({
          providerPaymentId: providerPayment,
          paidKopeks: 10000,
          merchantId: "synthetic-shop",
          test: false,
          verifiedAt: "2026-10-20T00:00:00.000Z",
          verification: "server_get_succeeded",
          currency: "RUB",
        }),
      ],
    );
    // Historical v1 checkout, not a newly constructed fiscal receipt or a
    // provider observation. It exactly matches this synthetic verified posting.
    await tx.query(
      `insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload,provider_payment_id,status)
       values($1,$2,$3,10000,'synthetic-shop',false,'https://pilot.example.test/balance','{"synthetic":true}',$4,'succeeded')`,
      [topup, userId, randomUUID(), providerPayment],
    );
  });
  const charges: {
    id: string;
    requestId: string;
    generationId: string;
    cost: RouterAiCharge | null;
  }[] = [];
  for (const [index, ceiling, costRub] of [
    [1, 10_000_000, "0.2169533830464"],
    [2, 6_000_000, "0.37526027951412"],
    [3, 6_000_000, null],
  ] as const) {
    const id = randomUUID(),
      requestId = randomUUID(),
      generationId = `synthetic-upgrade-generation-${index}`;
    const cost = costRub === null ? null : receipt(id, generationId, costRub);
    const debit =
      costRub === null
        ? 0
        : citygoDebitFromRealCostRub(costRub, CITYGO_10X_TARIFF)
            .citygoDebitMicros;
    const hold = ceiling * 10;
    await db.transaction(async (tx) => {
      await tx.query(
        "insert into chat_requests(thread_id,request_id,status) values($1,$2,'complete')",
        [threadId, requestId],
      );
      await tx.query(
        `insert into ai_model_attempts(thread_id,request_id,attempt_number,user_id,provider,model,policy_id,routing_revision,money_currency,money_reserved_micros,money_budget_revision,money_rule_key)
         values($1,$2,1,$3,'routerai',$4,$5,2,'RUB',$6,$7,$5)`,
        [
          threadId,
          requestId,
          userId,
          MODEL,
          POLICY,
          ceiling,
          index === 1 ? 3 : 4,
        ],
      );
      await tx.query(
        "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values($1,$2,'hold',$3)",
        [userId, id, hold],
      );
      await tx.query(
        "update ai_credit_accounts set held_micros=held_micros+$2 where user_id=$1",
        [userId, hold],
      );
      await tx.query(
        "update credit_source_lots set held_micros=held_micros+$2 where id=$1",
        [topup, hold],
      );
      await tx.query(
        "insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros) values($1,$2,0,$3)",
        [id, topup, hold],
      );
      await tx.query(
        `insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,dispatched,generation_id,response_complete,receipt,tariff_snapshot,real_ceiling_micros)
         values($1,$2,$3,$4,1,$5,'deepseek',true,$6,true,$7,$8,$9)`,
        [
          id,
          userId,
          threadId,
          requestId,
          MODEL,
          generationId,
          cost === null ? null : JSON.stringify(cost),
          JSON.stringify(CITYGO_10X_TARIFF),
          ceiling,
        ],
      );
      if (cost) {
        await tx.query(
          "update credit_source_lots set held_micros=held_micros-$2,spent_micros=spent_micros+$3 where id=$1",
          [topup, hold, debit],
        );
        await tx.query(
          "update credit_hold_allocations set state='settled',spent_micros=$2 where hold_id=$1",
          [id, debit],
        );
        await tx.query(
          "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id) values($1,$2,'settle',$3,$4)",
          [userId, randomUUID(), debit, id],
        );
        await tx.query(
          "update ai_credit_accounts set held_micros=held_micros-$2,spent_micros=spent_micros+$3 where user_id=$1",
          [userId, hold, debit],
        );
      }
    });
    charges.push({ id, requestId, generationId, cost });
  }
  await db.query(
    "update ai_budget set revision=4,enabled=true,currency='RUB',mode='routerai_balance',daily_limit_micros=null,total_limit_micros=null,total_reserved_micros=22000000,user_daily_limit_micros=null,rules=$1 where id=1",
    [JSON.stringify([{ key: POLICY, attemptCeilingMicros: 6_000_000 }])],
  );
  await db.query(
    "insert into ai_budget_daily(usage_day,reserved_micros) values('2026-10-20',22000000)",
  );
  await db.query(
    "insert into ai_model_attempt_daily(usage_day,reserved_attempts,user_limit,global_limit) values('2026-10-20',3,20,100)",
  );
  await db.query(
    "insert into ai_user_model_attempt_daily(user_id,usage_day,reserved_attempts) values($1,'2026-10-20',3)",
    [userId],
  );
  return { userId, threadId, topup, charges };
}

test("23→24 preserves paid money, exact historical receipts, pending full holds and account history without enabling overdraft", async (t) => {
  const db = await fixture(t);
  const f = await seed23(db);
  assert.deepEqual(await rawBalance(db, f.userId), {
    granted: "100000000",
    spent: "5922135",
    held: "60000000",
    available: "34077865",
  });
  const before = await history(db),
    oldJournal = await journal(db);
  assert.equal(before.messages!.length, 14);
  assert.equal(before.sessions!.length, 1);
  assert.equal(before.user_credentials!.length, 1);
  assert.equal(oldJournal.length, 23);
  await migrate(db);
  assert.deepEqual(
    await history(db),
    before,
    "Existing rows change only by the new explicit default reservation_mode",
  );
  const upgradedJournal = await journal(db);
  assert.deepEqual(
    upgradedJournal.slice(0, 23),
    oldJournal,
    "Original checksum and applied_at remain intact",
  );
  assert.equal(upgradedJournal.at(-1)!.name, "0024_ai_credit_overdraft.sql");
  assert.deepEqual(
    (await db.query("select distinct reservation_mode from ai_credit_charges"))
      .rows,
    [{ reservation_mode: "full" }],
  );
  for (const table of ["credit_charge_debts", "credit_debt_repayments"])
    assert.equal(
      (await db.query(`select count(*)::int as n from ${table}`)).rows[0]!.n,
      0,
    );
  const newCharges = new AiCreditCharges(
    db,
    CITYGO_10X_TARIFF,
    "fixed5_overdraft",
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        "select id from account_security_state where id=1 for update",
      );
      return newCharges.reserve(
        tx,
        {
          userId: f.userId,
          threadId: f.threadId,
          requestId: randomUUID(),
          model: MODEL,
          upstream: "deepseek",
        },
        6_000_000,
      );
    }),
    (error) =>
      error instanceof DomainError && error.code === "AI_CREDIT_UNAVAILABLE",
  );
  assert.deepEqual(
    await history(db),
    before,
    "Old pending full hold blocks another dispatch without any money mutation",
  );
  const pending = f.charges[2]!;
  await newCharges.settle(
    f.userId,
    pending.id,
    receipt(pending.id, pending.generationId, "0.2"),
  );
  const balance = await new AiCreditLedger(
    db,
    "routerai_citygo_10x",
    false,
    "fixed5_overdraft",
  ).status(f.userId);
  assert.equal(balance.availableMicros, 92_077_865);
  assert.equal(balance.spentMicros, 7_922_135);
  assert.equal(balance.heldMicros, 0);
  assert.equal(balance.outstandingDebtMicros, 0);
  assert.equal(balance.pending?.length, 0);
  for (const previous of f.charges.slice(0, 2)) {
    const charge = await newCharges.get(f.userId, previous.id);
    assert.deepEqual(charge.receipt, previous.cost);
    assert.equal(charge.reservation_mode, "full");
  }
  const settled = await newCharges.get(f.userId, pending.id);
  assert.equal(settled.reservation_mode, "full");
  assert.equal(Number(settled.real_ceiling_micros), 6_000_000);
  assert.equal(Number(settled.amount_micros), 60_000_000);
  const after = await history(db);
  for (const [table] of snapshotTables)
    if (
      ![
        "ai_credit_accounts",
        "ai_credit_entries",
        "credit_source_lots",
        "credit_hold_allocations",
      ].includes(table)
    )
      assert.deepEqual(
        after[table],
        before[table],
        "Legacy settlement leaves all other history unchanged: " + table,
      );
  const finalJournal = await journal(db);
  await migrate(db);
  await newCharges.settle(
    f.userId,
    pending.id,
    receipt(pending.id, pending.generationId, "0.2"),
  );
  assert.deepEqual(
    await history(db),
    after,
    "Migration and old full settlement replay are both idempotent",
  );
  assert.deepEqual(await journal(db), finalJournal);
});

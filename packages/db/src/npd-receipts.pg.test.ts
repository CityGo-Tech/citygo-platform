import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import {
  connectDatabase,
  migrate,
  Repository,
  AiCreditLedger,
  DomainError,
  type Database,
  type Sql,
} from "./index.js";
import { NpdReceipts, type NpdReceiptContext } from "./npd-receipts.js";

const pgOnly = {
  skip: process.env.TEST_DATABASE_URL
    ? false
    : "Requires opt-in localhost disposable PostgreSQL; PGlite is not race evidence",
  timeout: 60_000,
};

test(
  "PostgreSQL actual API role supports NPD reports and invoker top-up hooks without identity or history erasure",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    for (const role of ["citygo_api", "citygo_worker", "citygo_backup"]) {
      if (
        !(await f.db.query("select 1 from pg_roles where rolname=$1", [role]))
          .rows.length
      )
        await f.db.exec(`create role ${role}`);
    }
    const grants = await readFile(
      new URL("../../../deploy/postgres/grants.sql", import.meta.url),
      "utf8",
    );
    await f.db.exec(grants.replace(/^\\set[^\n]*\n/gm, ""));
    const roleDb: Database = {
      ...f.db,
      transaction: (work) =>
        f.db.transaction(async (tx) => {
          await tx.exec("set local role citygo_api");
          return work(tx);
        }),
    };
    const receipts = new NpdReceipts(roleDb);
    const claim = await receipts.command(f.first, f.id, {
      action: "claim",
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    const reported = await receipts.command(f.first, f.id, {
      action: "register",
      requestId: randomUUID(),
      expectedRevision: claim.task.revision,
      receiptId: "runtime-receipt",
      receiptUrl: receiptUrl("runtime-receipt"),
      amountKopeks: 10000,
      operatorReported: true,
    });
    await receipts.command(f.first, f.id, {
      action: "delivery",
      requestId: randomUUID(),
      expectedRevision: reported.task.revision,
      receiptEvidenceId: reported.task.activeEvidenceId!,
      channel: "email",
      operatorReported: true,
    });
    assert.equal(
      (await receipts.observeConfirmedRefund(refund(f, 1000))).task
        .correctionStatus,
      "required",
    );
    const operationId = randomUUID();
    await new AiCreditLedger(roleDb).topUpConfirmed(
      f.buyer.userId,
      operationId,
      {
        providerPaymentId: randomUUID(),
        paidKopeks: 10000,
        merchantId: "synthetic-shop",
        test: false,
        verifiedAt: new Date().toISOString(),
        verification: "server_get_succeeded",
        currency: "RUB",
      },
    );
    assert.ok(
      (await receipts.listAdmin(f.first)).tasks.some(
        (task) => task.id === operationId,
      ),
    );
    for (const sql of [
      "update npd_receipt_tasks set buyer_email='forged@example.test'",
      "delete from npd_receipt_commands",
      "update npd_receipt_evidence set amount_kopeks=1",
      "truncate npd_receipt_tasks cascade",
    ])
      await assert.rejects(
        roleDb.transaction((tx) => tx.exec(sql)),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "42501",
      );
  },
);

function signal() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
async function within<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(
            () => reject(new Error("Synthetic PostgreSQL barrier timed out")),
            5000,
          )),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(t: TestContext) {
  const base = process.env.TEST_DATABASE_URL;
  assert.ok(base);
  const url = new URL(base);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  // CI uses the declared PostgreSQL service on 5432; the local disposable
  // harness uses 55438. Neither can select a working application's database.
  assert.ok(["5432", "55438"].includes(url.port || "5432"));
  assert.ok(["/citygo_test", "/citygo_synthetic"].includes(url.pathname));
  assert.equal(url.search, "");
  const name = "cg_npd_test_" + randomUUID().replaceAll("-", "");
  assert.match(name, /^cg_npd_test_[a-f0-9]{32}$/);
  const adminDb = await connectDatabase(base);
  let created = false;
  const cleanup: { db?: Database } = {};
  t.after(async () => {
    try {
      await cleanup.db?.close();
      if (created) await adminDb.query(`drop database "${name}"`);
    } finally {
      await adminDb.close();
    }
  });
  await adminDb.query(`create database "${name}" template template0`);
  created = true;
  url.pathname = "/" + name;
  const db = await connectDatabase(url.toString());
  cleanup.db = db;
  await migrate(db);
  const repo = new Repository(db),
    ledger = new AiCreditLedger(db);
  const ids = [
    await repo.register("first@example.test", "synthetic"),
    await repo.register("second@example.test", "synthetic"),
    await repo.register("buyer@example.test", "synthetic"),
  ];
  await db.query(
    "update users set role='admin' where id=$1 or id=$2",
    ids.slice(0, 2),
  );
  const contexts: NpdReceiptContext[] = [];
  for (let i = 0; i < ids.length; i++) {
    const sessionTokenHash = ["a", "b", "c"][i]!.repeat(64);
    await db.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 day')",
      [sessionTokenHash, ids[i]!],
    );
    contexts.push({ userId: ids[i]!, sessionTokenHash });
  }
  const id = randomUUID(),
    paymentId = randomUUID();
  await ledger.topUpConfirmed(ids[2]!, id, {
    providerPaymentId: paymentId,
    paidKopeks: 10000,
    merchantId: "synthetic-shop",
    test: false,
    verifiedAt: "2026-10-18T00:00:00.000Z",
    verification: "server_get_succeeded",
    currency: "RUB",
  });
  return {
    db,
    store: new NpdReceipts(db),
    first: contexts[0]!,
    second: contexts[1]!,
    buyer: contexts[2]!,
    id,
    paymentId,
  };
}
function paused(db: Database, match: string) {
  const entered = signal(),
    release = signal();
  let held = false;
  const wrapper: Database = {
    ...db,
    transaction: (work) =>
      db.transaction((tx) =>
        work({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) => {
            const result = await tx.query<T>(sql, params);
            if (!held && sql.includes(match)) {
              held = true;
              entered.open();
              await release.promise;
            }
            return result;
          },
        }),
      ),
  };
  return { db: wrapper, entered, release };
}
async function waiting(db: Sql) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await db.query(
      "select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'",
    );
    if (rows.rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic PostgreSQL lock wait was not observed");
}
const receiptUrl = (value: string) =>
  `https://lknpd.nalog.ru/api/v1/receipt/SYNTHETIC_${value}/print`;
async function registered(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.command(f.first, f.id, {
    action: "claim",
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  return f.store.command(f.first, f.id, {
    action: "register",
    requestId: randomUUID(),
    expectedRevision: 2,
    receiptId: "original",
    receiptUrl: receiptUrl("original"),
    amountKopeks: 10000,
    operatorReported: true,
  });
}
function refund(f: Awaited<ReturnType<typeof fixture>>, amountKopeks: number) {
  return {
    userId: f.buyer.userId,
    providerPaymentId: f.paymentId,
    providerRefundId: randomUUID(),
    merchantId: "synthetic-shop",
    amountKopeks,
    currency: "RUB" as const,
    test: false as const,
    status: "succeeded" as const,
    verification: "server_get_succeeded" as const,
    observedAt: "2026-10-18T00:00:00.000Z",
  };
}
test(
  "PostgreSQL two operators contend for one claim under actual row locks, leaving one command",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    const gate = paused(
      f.db,
      "select id from npd_receipt_tasks where id=$1 for update",
    );
    const first = new NpdReceipts(gate.db).command(f.first, f.id, {
      action: "claim",
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    await within(gate.entered.promise);
    const second = f.store.command(f.second, f.id, {
      action: "claim",
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    const loser = assert.rejects(
      second,
      (error) => error instanceof DomainError && error.statusCode === 409,
    );
    try {
      await waiting(f.db);
    } finally {
      gate.release.open();
    }
    assert.equal((await first).task.claimedByUserId, f.first.userId);
    await loser;
    assert.equal(
      (await f.db.query("select * from npd_receipt_commands")).rows.length,
      1,
    );
  },
);
test(
  "PostgreSQL newly observed refund invalidates a waiting stale correction before it can close",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    await registered(f);
    const initial = await f.store.observeConfirmedRefund(refund(f, 3000));
    const gate = paused(f.db, "select id,merchant_id from npd_receipt_tasks");
    const observed = new NpdReceipts(gate.db).observeConfirmedRefund(
      refund(f, 2000),
    );
    await within(gate.entered.promise);
    const correction = f.store.command(f.first, f.id, {
      action: "correction",
      requestId: randomUUID(),
      expectedRevision: initial.task.revision,
      refundSnapshotKopeks: 3000,
      canceledReceiptId: "original",
      evidenceUrl: receiptUrl("cancel"),
      replacement: {
        receiptId: "remaining-70",
        receiptUrl: receiptUrl("remaining-70"),
        amountKopeks: 7000,
      },
      operatorReported: true,
    });
    const stale = assert.rejects(
      correction,
      (error) => error instanceof DomainError && error.statusCode === 409,
    );
    try {
      await waiting(f.db);
    } finally {
      gate.release.open();
    }
    await observed;
    await stale;
    const detail = await f.store.detailAdmin(f.first, f.id);
    assert.equal(detail.task.correctionStatus, "required");
    assert.equal(detail.task.remainingIncomeKopeks, 5000);
    assert.equal(
      (await f.db.query("select * from npd_receipt_evidence")).rows.length,
      1,
    );
  },
);
test(
  "PostgreSQL refund after an admitted correction reopens the obligation and preserves prior evidence",
  pgOnly,
  async (t) => {
    const f = await fixture(t);
    await registered(f);
    const initial = await f.store.observeConfirmedRefund(refund(f, 3000));
    const gate = paused(
      f.db,
      "select id from npd_receipt_tasks where id=$1 for update",
    );
    const correction = new NpdReceipts(gate.db).command(f.first, f.id, {
      action: "correction",
      requestId: randomUUID(),
      expectedRevision: initial.task.revision,
      refundSnapshotKopeks: 3000,
      canceledReceiptId: "original",
      evidenceUrl: receiptUrl("cancel"),
      replacement: {
        receiptId: "remaining-70",
        receiptUrl: receiptUrl("remaining-70"),
        amountKopeks: 7000,
      },
      operatorReported: true,
    });
    await within(gate.entered.promise);
    const observed = f.store.observeConfirmedRefund(refund(f, 2000));
    try {
      await waiting(f.db);
    } finally {
      gate.release.open();
    }
    assert.equal((await correction).task.correctionStatus, "operator_reported");
    await observed;
    const detail = await f.store.detailAdmin(f.first, f.id);
    assert.equal(detail.task.correctionStatus, "required");
    assert.equal(detail.task.remainingIncomeKopeks, 5000);
    assert.equal(
      (await f.db.query("select * from npd_receipt_evidence")).rows.length,
      2,
    );
  },
);

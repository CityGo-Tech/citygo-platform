import { registerSyntheticConsentingUser } from "./test-service-consents.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { CONTRACT_VERSION_HEADER } from "@citygo/contracts";
import {
  AiCreditLedger,
  NpdReceipts,
  Repository,
  connectDatabase,
  migrate,
  type Database,
} from "@citygo/db";
import { readConfig } from "@citygo/config";
import { buildApp } from "./app.js";
import { tokenHash } from "./auth.js";

async function fixture(t: TestContext) {
  const raw = await connectDatabase("pglite://:memory:");
  let beforeTransaction: (() => Promise<void>) | undefined;
  const db: Database = {
    ...raw,
    transaction: async (work) => {
      const hook = beforeTransaction;
      beforeTransaction = undefined;
      await hook?.();
      return raw.transaction(work);
    },
  };
  await migrate(db);
  const repo = new Repository(db);
  const people = [];
  for (const role of ["super_admin", "admin", "user"] as const) {
    const userId = await registerSyntheticConsentingUser(
      db,
      `${role}@example.test`,
      "synthetic-unused-hash",
    );
    await db.query("update users set role=$2 where id=$1", [userId, role]);
    const token = randomUUID();
    await repo.createSession(userId, tokenHash(token));
    people.push({ userId, token });
  }
  const [superAdmin, admin, owner] = people as [
    { userId: string; token: string },
    { userId: string; token: string },
    { userId: string; token: string },
  ];
  const config = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: "pglite://:memory:",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const app = await buildApp({ db, config, testing: true });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const call = (
    method: "GET" | "POST",
    path: string,
    token = "",
    body?: object,
    extraHeaders: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        [CONTRACT_VERSION_HEADER]: "1",
        origin: "http://localhost:3000",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { payload: body }),
    });
  const paid = async (testPayment = false, userId = owner.userId) => {
    const operationId = randomUUID();
    const paymentId = randomUUID();
    await new AiCreditLedger(db).topUpConfirmed(userId, operationId, {
      providerPaymentId: paymentId,
      paidKopeks: 10000,
      merchantId: "synthetic-npd-shop",
      test: testPayment,
      verifiedAt: new Date().toISOString(),
      verification: "server_get_succeeded",
      currency: "RUB",
    });
    return { operationId, paymentId };
  };
  return {
    db,
    app,
    call,
    superAdmin,
    admin,
    owner,
    paid,
    intercept: (hook: () => Promise<void>) => {
      beforeTransaction = hook;
    },
  };
}

const base = "/v1/admin/npd/receipts";

test("receipt HTTP is authenticated; ordinary users cannot read or mutate admin registry", async (t) => {
  const f = await fixture(t);
  for (const [method, path, body] of [
    ["GET", base, undefined],
    ["GET", `${base}/${randomUUID()}`, undefined],
    [
      "POST",
      `${base}/${randomUUID()}/commands`,
      { action: "claim", requestId: randomUUID(), expectedRevision: 1 },
    ],
  ] as const) {
    assert.equal((await f.call(method, path, "", body)).statusCode, 401);
    assert.equal(
      (await f.call(method, path, f.owner.token, body)).statusCode,
      403,
    );
  }
  assert.equal((await f.call("GET", "/v1/payments/receipts")).statusCode, 401);
});

test("live trusted posting atomically appears once, while owner projection cannot leak another buyer", async (t) => {
  const f = await fixture(t);
  const payment = await f.paid();
  const list = await f.call("GET", base, f.admin.token);
  assert.equal(list.statusCode, 200, list.body);
  const tasks = list.json().tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].amountKopeks, 10000);
  assert.ok(list.body.includes(payment.paymentId));
  const own = await f.call("GET", "/v1/payments/receipts", f.owner.token);
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().tasks.length, 1);
  assert.equal(
    /buyerEmail|sessionTokenHash|events|synthetic-unused-hash/.test(own.body),
    false,
  );
  const other = await f.call("GET", "/v1/payments/receipts", f.admin.token);
  assert.equal(other.statusCode, 200, other.body);
  assert.deepEqual(other.json().tasks, []);
  assert.equal(
    (
      await f.call(
        "GET",
        `/v1/payments/receipts?userId=${f.owner.userId}`,
        f.admin.token,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.call("POST", base, f.admin.token, {
        paymentId: payment.paymentId,
      })
    ).statusCode,
    404,
  );
});

test("sandbox top-ups never create real NPD obligations", async (t) => {
  const f = await fixture(t);
  await f.paid(true);
  const list = await f.call("GET", base, f.superAdmin.token);
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json().tasks, []);
});

test("claim, registration and actual manual delivery are distinct audited idempotent HTTP operations", async (t) => {
  const f = await fixture(t);
  await f.paid();
  const list = await f.call(
    "GET",
    `${base}?limit=1&status=pending`,
    f.admin.token,
  );
  assert.equal(list.statusCode, 200, list.body);
  const task = list.json().tasks[0];
  const path = `${base}/${task.id}/commands`;
  const claim = await f.call("POST", path, f.admin.token, {
    action: "claim",
    requestId: randomUUID(),
    expectedRevision: task.revision,
  });
  assert.equal(claim.statusCode, 200, claim.body);
  const claimed = claim.json().task;
  const secondActor = await f.call("POST", path, f.superAdmin.token, {
    action: "claim",
    requestId: randomUUID(),
    expectedRevision: claimed.revision,
  });
  assert.equal(secondActor.statusCode, 409, secondActor.body);
  const registration = {
    action: "register",
    requestId: randomUUID(),
    expectedRevision: claimed.revision,
    receiptId: "synthetic-receipt",
    receiptUrl:
      "https://lknpd.nalog.ru/api/v1/receipt/000000000000/synthetic-receipt/print",
    amountKopeks: 10000,
    operatorReported: true,
  };
  const wrongAmount = await f.call("POST", path, f.admin.token, {
    ...registration,
    amountKopeks: 1000,
  });
  assert.equal(wrongAmount.statusCode, 409, wrongAmount.body);
  const registered = await f.call("POST", path, f.admin.token, registration);
  assert.equal(registered.statusCode, 200, registered.body);
  assert.equal(registered.json().task.registrationStatus, "operator_reported");
  assert.equal(registered.json().task.deliveryStatus, "pending");
  const repeated = await f.call("POST", path, f.admin.token, registration);
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().task.revision, registered.json().task.revision);
  assert.equal(repeated.json().events.length, registered.json().events.length);
  const conflicted = await f.call("POST", path, f.admin.token, {
    ...registration,
    receiptId: "different-receipt",
  });
  assert.equal(conflicted.statusCode, 409, conflicted.body);
  const delivery = await f.call("POST", path, f.admin.token, {
    action: "delivery",
    requestId: randomUUID(),
    expectedRevision: registered.json().task.revision,
    receiptEvidenceId: registered.json().task.activeEvidenceId,
    channel: "email",
    operatorReported: true,
  });
  assert.equal(delivery.statusCode, 200, delivery.body);
  assert.equal(delivery.json().task.deliveryStatus, "operator_reported");
  assert.equal(delivery.json().events.length, 3);
  const view = await f.call("GET", `${base}/${task.id}`, f.admin.token);
  assert.equal(view.statusCode, 200, view.body);
  assert.equal(view.json().task.activeReceiptId, registration.receiptId);
  assert.equal(/synthetic-unused-hash|sessionTokenHash/.test(view.body), false);
});

test("strict receipt inputs reject malformed IDs, oversized filters and forged evidence without echo", async (t) => {
  const f = await fixture(t);
  for (const path of [
    `${base}/invalid`,
    `${base}?limit=100000`,
    `${base}?limit=`,
    `${base}?limit=0`,
    `${base}?limit=01`,
    `${base}?limit=1.0`,
    `${base}?limit=101`,
    `${base}?limit=1&limit=2`,
    `${base}?owner=SECRET-OWNER`,
  ]) {
    const response = await f.call("GET", path, f.admin.token);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.body.includes("SECRET-OWNER"), false);
  }
  const response = await f.call(
    "POST",
    `${base}/${randomUUID()}/commands`,
    f.admin.token,
    {
      action: "refund",
      requestId: randomUUID(),
      expectedRevision: 1,
      apiKey: "SECRET-KEY",
    },
  );
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.body.includes("SECRET-KEY"), false);
});

test("receipt role/session is rechecked inside the security transaction after HTTP authentication", async (t) => {
  const f = await fixture(t);
  f.intercept(async () => {
    await f.db.query("delete from sessions where token_hash=$1", [
      tokenHash(f.admin.token),
    ]);
  });
  const revoked = await f.call("GET", base, f.admin.token);
  assert.equal(revoked.statusCode, 401, revoked.body);
  f.intercept(async () => {
    await f.db.query("update users set role='user' where id=$1", [
      f.superAdmin.userId,
    ]);
  });
  const demoted = await f.call("GET", base, f.superAdmin.token);
  assert.equal(demoted.statusCode, 403, demoted.body);
});

test("temporary admin password and cross-origin writes are rejected", async (t) => {
  const f = await fixture(t);
  await f.db.query("update users set must_change_password=true where id=$1", [
    f.admin.userId,
  ]);
  assert.equal((await f.call("GET", base, f.admin.token)).statusCode, 403);
  const cross = await f.call(
    "POST",
    `${base}/${randomUUID()}/commands`,
    f.superAdmin.token,
    { action: "claim", requestId: randomUUID(), expectedRevision: 1 },
    { origin: "https://attacker.example" },
  );
  assert.equal(cross.statusCode, 403);
});

test("contradictory stored reports fail as sanitized server errors, not successful receipts or input errors", async (t) => {
  const f = await fixture(t);
  const payment = await f.paid();
  // Deliberate corruption in a disposable PGlite only; runtime grants cannot
  // disable this trigger or manufacture this contradictory successful state.
  await f.db.exec(
    "alter table npd_receipt_tasks disable trigger npd_receipt_task_guard",
  );
  await f.db.query(
    "update npd_receipt_tasks set registration_status='operator_reported' where id=$1",
    [payment.operationId],
  );
  await f.db.exec(
    "alter table npd_receipt_tasks enable trigger npd_receipt_task_guard",
  );
  for (const [path, token] of [
    [base, f.admin.token],
    [`${base}/${payment.operationId}`, f.admin.token],
    ["/v1/payments/receipts", f.owner.token],
  ]) {
    const result = await f.call("GET", path!, token!);
    assert.equal(result.statusCode, 500, result.body);
    assert.equal(
      /example.test|paymentId|operator_reported|ZodError/.test(result.body),
      false,
    );
  }
});

test("refund observations invalidate stale correction forms; partial and full correction preserve history and require new delivery", async (t) => {
  const f = await fixture(t);
  const payment = await f.paid();
  const initial = (await f.call("GET", base, f.admin.token)).json().tasks[0];
  const path = `${base}/${initial.id}/commands`;
  const claimed = await f.call("POST", path, f.admin.token, {
    action: "claim",
    requestId: randomUUID(),
    expectedRevision: initial.revision,
  });
  const registered = await f.call("POST", path, f.admin.token, {
    action: "register",
    requestId: randomUUID(),
    expectedRevision: claimed.json().task.revision,
    receiptId: "initial-receipt",
    receiptUrl:
      "https://lknpd.nalog.ru/api/v1/receipt/000000000000/initial-receipt/print",
    amountKopeks: 10000,
    operatorReported: true,
  });
  assert.equal(registered.statusCode, 200, registered.body);
  const receipts = new NpdReceipts(f.db);
  const observation = {
    userId: f.owner.userId,
    providerPaymentId: payment.paymentId,
    providerRefundId: randomUUID(),
    merchantId: "synthetic-npd-shop",
    amountKopeks: 4000,
    currency: "RUB" as const,
    test: false as const,
    status: "succeeded" as const,
    verification: "server_get_succeeded" as const,
    observedAt: new Date().toISOString(),
  };
  const observed = await receipts.observeConfirmedRefund(observation);
  assert.equal(observed.task.correctionStatus, "required");
  const correction = {
    action: "correction",
    requestId: randomUUID(),
    expectedRevision: registered.json().task.revision,
    refundSnapshotKopeks: 4000,
    canceledReceiptId: "initial-receipt",
    evidenceUrl:
      "https://lknpd.nalog.ru/api/v1/receipt/000000000000/initial-receipt/print",
    replacement: {
      receiptId: "remaining-receipt",
      receiptUrl:
        "https://lknpd.nalog.ru/api/v1/receipt/000000000000/remaining-receipt/print",
      amountKopeks: 6000,
    },
    operatorReported: true,
  };
  assert.equal(
    (await f.call("POST", path, f.admin.token, correction)).statusCode,
    409,
  );
  const corrected = await f.call("POST", path, f.admin.token, {
    ...correction,
    expectedRevision: observed.task.revision,
  });
  assert.equal(corrected.statusCode, 200, corrected.body);
  assert.equal(corrected.json().task.remainingIncomeKopeks, 6000);
  assert.equal(corrected.json().task.deliveryStatus, "pending");
  assert.ok(
    corrected
      .json()
      .events.some((event: { action: string }) => event.action === "register"),
  );
  assert.equal(
    (await receipts.observeConfirmedRefund(observation)).task.revision,
    corrected.json().task.revision,
  );
  const fullRefund = await receipts.observeConfirmedRefund({
    ...observation,
    providerRefundId: randomUUID(),
    amountKopeks: 6000,
  });
  const full = await f.call("POST", path, f.admin.token, {
    ...correction,
    requestId: randomUUID(),
    expectedRevision: fullRefund.task.revision,
    refundSnapshotKopeks: 10000,
    canceledReceiptId: "remaining-receipt",
    evidenceUrl:
      "https://lknpd.nalog.ru/api/v1/receipt/000000000000/remaining-receipt/print",
    replacement: null,
  });
  assert.equal(full.statusCode, 200, full.body);
  assert.equal(full.json().task.remainingIncomeKopeks, 0);
  assert.ok(full.json().task.activeReceiptUrl);
  assert.equal(full.json().task.deliveryStatus, "pending");
  const delivered = await f.call("POST", path, f.admin.token, {
    action: "delivery",
    requestId: randomUUID(),
    expectedRevision: full.json().task.revision,
    receiptEvidenceId: full.json().task.activeEvidenceId,
    channel: "email",
    operatorReported: true,
  });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.equal(delivered.json().task.deliveryStatus, "operator_reported");
  const ledger = await new AiCreditLedger(f.db).status(f.owner.userId);
  assert.equal(
    ledger.grantedMicros,
    100000000,
    "receipt reports never debit money: refund money ledger is a separate required feature",
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  npdReceiptCommandSchema,
  npdReceiptEvidenceUrlSchema,
  npdReceiptListQuerySchema,
  npdReceiptEventSchema,
  ownerNpdReceiptTaskSchema,
} from "./npd-receipts.js";
const base = { requestId: randomUUID(), expectedRevision: 1 };
const url = "https://lknpd.nalog.ru/api/v1/receipt/SYNTHETIC/print";
test("manual commands have strict separate registration, delivery, review and correction shapes", () => {
  for (const command of [
    { ...base, action: "claim" },
    {
      ...base,
      action: "register",
      receiptId: "synthetic",
      receiptUrl: url,
      amountKopeks: 10000,
      operatorReported: true,
    },
    {
      ...base,
      action: "delivery",
      receiptEvidenceId: randomUUID(),
      channel: "email",
      operatorReported: true,
    },
    { ...base, action: "review", reason: "registration_uncertain" },
    {
      ...base,
      action: "correction",
      refundSnapshotKopeks: 10000,
      canceledReceiptId: "synthetic",
      evidenceUrl: url,
      replacement: null,
      operatorReported: true,
    },
  ])
    assert.equal(npdReceiptCommandSchema.safeParse(command).success, true);
  for (const extra of [
    { userId: "1" },
    { role: "super_admin" },
    { paid: true },
    { approved: true },
    { test: false },
    { deliveryStatus: "delivered" },
  ])
    assert.equal(
      npdReceiptCommandSchema.safeParse({ ...base, action: "claim", ...extra })
        .success,
      false,
    );
  assert.equal(
    npdReceiptCommandSchema.safeParse({
      ...base,
      action: "refund_observed",
      amountKopeks: 10000,
    }).success,
    false,
  );
  assert.equal(
    npdReceiptCommandSchema.safeParse({
      ...base,
      action: "delivery",
      receiptEvidenceId: randomUUID(),
      channel: "account",
      operatorReported: true,
    }).success,
    false,
  );
});

test("stored reported states and history require coherent evidence, actor, revision and command identity", () => {
  const id = randomUUID(),
    evidenceId = randomUUID();
  const task = {
    id,
    userId: "1",
    paymentId: "synthetic",
    paymentProvider: "yookassa",
    amountKopeks: 10000,
    cumulativeRefundedKopeks: 0,
    remainingIncomeKopeks: 10000,
    revision: 3,
    registrationStatus: "operator_reported",
    deliveryStatus: "pending",
    correctionStatus: "not_required",
    activeEvidenceId: evidenceId,
    activeReceiptId: "synthetic",
    activeReceiptUrl: url,
    reviewReason: null,
    observedAt: "2026-10-18T00:00:00.000Z",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
  assert.equal(ownerNpdReceiptTaskSchema.safeParse(task).success, true);
  for (const patch of [
    {
      activeEvidenceId: null,
      activeReceiptId: null,
      activeReceiptUrl: null,
      deliveryStatus: "operator_reported",
    },
    { activeEvidenceId: null },
    { activeReceiptUrl: null },
    { activeReceiptId: null },
    { registrationStatus: "pending" },
    { correctionStatus: "required" },
    { deliveryStatus: "operator_reported", reviewReason: "delivery_uncertain" },
  ])
    assert.equal(
      ownerNpdReceiptTaskSchema.safeParse({ ...task, ...patch }).success,
      false,
    );
  const payload = {
    action: "claim",
    requestId: base.requestId,
    expectedRevision: 1,
  };
  const event = {
    requestId: base.requestId,
    action: "claim",
    actorUserId: "2",
    revision: 2,
    payload,
    createdAt: "2026-10-18T00:00:00.000Z",
  };
  assert.equal(npdReceiptEventSchema.safeParse(event).success, true);
  for (const patch of [
    { action: "delivery" },
    { actorUserId: null },
    { revision: 8 },
    { requestId: randomUUID() },
  ])
    assert.equal(
      npdReceiptEventSchema.safeParse({ ...event, ...patch }).success,
      false,
    );
});
test("receipt evidence allows only the explicit HTTPS FNS host without claiming FNS verification", () => {
  assert.equal(npdReceiptEvidenceUrlSchema.parse(url), url);
  for (const receiptUrl of [
    "http://lknpd.nalog.ru/path",
    "https://lknpd.nalog.ru.evil.test/path",
    "https://user:password@lknpd.nalog.ru/path",
    "https://evil.test/path",
    "https://lknpd.nalog.ru/",
    "https://lknpd.nalog.ru/path?private=1",
    "https://lknpd.nalog.ru/path#private",
  ])
    assert.equal(
      npdReceiptEvidenceUrlSchema.safeParse(receiptUrl).success,
      false,
    );
});
test("command revisions and monetary amounts never coerce and UUID variants normalize", () => {
  const claim = {
    ...base,
    action: "claim",
    requestId: base.requestId.toUpperCase(),
  };
  assert.equal(npdReceiptCommandSchema.parse(claim).requestId, base.requestId);
  for (const expectedRevision of [0, -1, "1", 1.5, 2147483648])
    assert.equal(
      npdReceiptCommandSchema.safeParse({
        ...base,
        action: "claim",
        expectedRevision,
      }).success,
      false,
    );
  for (const amountKopeks of [0, 100.1, "100", 1_000_000_001])
    assert.equal(
      npdReceiptCommandSchema.safeParse({
        ...base,
        action: "register",
        receiptId: "synthetic",
        receiptUrl: url,
        amountKopeks,
        operatorReported: true,
      }).success,
      false,
    );
});
test("queue pagination is bounded and owner projection excludes admin contacts/audit", () => {
  assert.deepEqual(npdReceiptListQuerySchema.parse({}), { limit: 50 });
  for (const limit of [0, 101, "50", true])
    assert.equal(npdReceiptListQuerySchema.safeParse({ limit }).success, false);
  const task = {
    id: randomUUID(),
    userId: "1",
    paymentId: "synthetic",
    paymentProvider: "yookassa",
    amountKopeks: 10000,
    cumulativeRefundedKopeks: 3000,
    remainingIncomeKopeks: 7000,
    revision: 1,
    registrationStatus: "pending",
    deliveryStatus: "pending",
    correctionStatus: "required",
    activeEvidenceId: null,
    activeReceiptId: null,
    activeReceiptUrl: null,
    reviewReason: null,
    observedAt: "2026-10-18T00:00:00.000Z",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
  assert.equal(ownerNpdReceiptTaskSchema.safeParse(task).success, true);
  for (const extra of [
    { buyerEmail: "private@example.test" },
    { claimedByUserId: "2" },
    { events: [] },
    { remainingIncomeKopeks: 6999 },
  ])
    assert.equal(
      ownerNpdReceiptTaskSchema.safeParse({ ...task, ...extra }).success,
      false,
    );
});

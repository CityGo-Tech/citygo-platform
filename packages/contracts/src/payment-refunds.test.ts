import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaymentRefundSchema,
  reconcilePaymentRefundSchema,
  paymentRefundListQuerySchema,
  adminPaymentRefundSchema,
  adminPaymentRefundDetailSchema,
  ownerPaymentRefundSchema,
  paymentRefundEventSchema,
  adminPaymentSourceSchema,
  ownerPaymentSourceSchema,
} from "./payment-refunds.js";

const id = "a28e0d51-e390-4b82-899c-edc97156f93b";
const otherId = "764a1c6f-be17-4110-8a21-cb7d73783ccb";
const stamp = "2026-10-18T12:00:00.000Z";
const ownerRefund = {
  id,
  paymentOperationId: otherId,
  amountKopeks: 100,
  test: true,
  status: "reserved",
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
};
const refund = {
  ...ownerRefund,
  requestId: id,
  userId: "1",
  providerPaymentId: otherId,
  merchantId: "synthetic-shop",
  providerRefundId: null,
  attemptCount: 0,
  lastAttemptAt: null,
  reviewReason: null,
};
const source = {
  sourceOperationId: id,
  test: true,
  grossMicros: 100_000_000,
  availableMicros: 100_000_000,
  spentMicros: 0,
  heldMicros: 0,
  refundReservedMicros: 0,
  refundedMicros: 0,
  createdAt: stamp,
};

test("refund creation uses an exact UUID/kopeks command, not user-supplied provider evidence", () => {
  const input = {
    requestId: id,
    paymentOperationId: otherId,
    amountKopeks: 100,
  };
  assert.deepEqual(createPaymentRefundSchema.parse(input), input);
  for (const patch of [
    { amountKopeks: 99 },
    { amountKopeks: 100.1 },
    { amountKopeks: "100" },
    { requestId: "not-a-uuid" },
    { test: false },
    { status: "succeeded" },
    { providerRefundId: id },
    { receiptUrl: "https://example.test" },
  ])
    assert.equal(
      createPaymentRefundSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
});

test("refund reconciliation takes only an optional candidate ID, never proof of success", () => {
  assert.deepEqual(reconcilePaymentRefundSchema.parse({}), {});
  assert.deepEqual(
    reconcilePaymentRefundSchema.parse({ candidateProviderRefundId: id }),
    { candidateProviderRefundId: id },
  );
  for (const input of [
    { candidateProviderRefundId: "secret@example.test" },
    { status: "succeeded" },
    { amountKopeks: 100 },
    { apiKey: "private" },
  ])
    assert.equal(reconcilePaymentRefundSchema.safeParse(input).success, false);
});

test("refund lists are bounded, strict, non-coercing and default to 50", () => {
  assert.deepEqual(paymentRefundListQuerySchema.parse({}), { limit: 50 });
  for (const input of [
    { limit: 0 },
    { limit: 101 },
    { limit: "20" },
    { after: "x" },
    { status: "paid" },
    { userId: "1" },
  ])
    assert.equal(paymentRefundListQuerySchema.safeParse(input).success, false);
});

test("refund output validates terminal provider IDs and cannot expose admin fields to owners", () => {
  assert.equal(adminPaymentRefundSchema.safeParse(refund).success, true);
  for (const status of ["pending", "succeeded", "canceled"]) {
    assert.equal(
      adminPaymentRefundSchema.safeParse({ ...refund, status }).success,
      false,
    );
    assert.equal(
      adminPaymentRefundSchema.safeParse({
        ...refund,
        status,
        providerRefundId: otherId,
      }).success,
      true,
    );
  }
  assert.equal(ownerPaymentRefundSchema.safeParse(ownerRefund).success, true);
  assert.equal(ownerPaymentRefundSchema.safeParse(refund).success, false);
  for (const patch of [
    { userId: "01" },
    { reviewReason: "raw provider email private@example.test" },
    { amountKopeks: -1 },
    { revision: 0 },
  ])
    assert.equal(
      adminPaymentRefundSchema.safeParse({ ...refund, ...patch }).success,
      false,
    );
});

test("refund events allow only bounded operational metadata and explicit observation type", () => {
  const event = {
    sequence: 1,
    action: "provider_observed",
    actorUserId: null,
    revision: 2,
    createdAt: stamp,
    payload: {
      providerStatus: "succeeded",
      providerRefundId: otherId,
      observation: "server_get",
    },
  };
  assert.equal(paymentRefundEventSchema.safeParse(event).success, true);
  for (const patch of [
    { body: "raw provider response" },
    { email: "private@example.test" },
    { reason: "unknown free text" },
    { observation: "browser_redirect" },
  ])
    assert.equal(
      paymentRefundEventSchema.safeParse({
        ...event,
        payload: { ...event.payload, ...patch },
      }).success,
      false,
    );
});

test("refund audit binds each action to its exact payload and actor responsibility", () => {
  const base = { sequence: 1, actorUserId: "1", revision: 1, createdAt: stamp };
  const cases = [
    { ...base, action: "reserved", payload: { amountKopeks: 100 } },
    { ...base, action: "dispatch_started", payload: {} },
    {
      ...base,
      action: "provider_observed",
      actorUserId: null,
      payload: {
        providerRefundId: otherId,
        providerStatus: "pending",
        observation: "create_response",
      },
    },
    {
      ...base,
      action: "review_required",
      actorUserId: null,
      payload: { reason: "manual_review_required" },
    },
    {
      ...base,
      action: "dispatch_failed",
      actorUserId: null,
      payload: {
        reason: "provider_transport_failure",
        observation: "server_get",
      },
    },
  ];
  for (const event of cases)
    assert.equal(paymentRefundEventSchema.safeParse(event).success, true);
  for (const event of [
    { ...cases[0], actorUserId: null },
    { ...cases[0], payload: {} },
    { ...cases[1], payload: { amountKopeks: 100 } },
    { ...cases[1], actorUserId: null },
    { ...cases[2], actorUserId: "1" },
    { ...cases[2], payload: { reason: "provider_transport_failure" } },
    {
      ...cases[2],
      payload: { providerRefundId: otherId, providerStatus: "pending" },
    },
    { ...cases[3], payload: {} },
    {
      ...cases[3],
      payload: { reason: "manual_review_required", providerRefundId: otherId },
    },
    { ...cases[4], actorUserId: "1" },
    {
      ...cases[4],
      payload: {
        reason: "provider_transport_failure",
        observation: "create_response",
      },
    },
  ])
    assert.equal(paymentRefundEventSchema.safeParse(event).success, false);
});

test("refund attempts and attempt timestamp agree with reserved/unknown state", () => {
  assert.equal(
    adminPaymentRefundSchema.safeParse({
      ...refund,
      status: "review_required",
      reviewReason: "configuration_mismatch",
    }).success,
    true,
  );
  assert.equal(
    adminPaymentRefundSchema.safeParse({
      ...refund,
      status: "unknown",
      attemptCount: 1,
      lastAttemptAt: stamp,
    }).success,
    true,
  );
  for (const patch of [
    { attemptCount: 0, lastAttemptAt: stamp },
    { attemptCount: 1, lastAttemptAt: null },
    { status: "reserved", attemptCount: 1, lastAttemptAt: stamp },
    { status: "reserved", providerRefundId: otherId },
    { status: "unknown", attemptCount: 0 },
  ])
    assert.equal(
      adminPaymentRefundSchema.safeParse({ ...refund, ...patch }).success,
      false,
    );
});

test("refund detail cannot accept duplicate/future events or another reserved amount", () => {
  const event = {
    sequence: 1,
    action: "reserved",
    actorUserId: "1",
    revision: 1,
    createdAt: stamp,
    payload: { amountKopeks: 100 },
  };
  assert.equal(
    adminPaymentRefundDetailSchema.safeParse({ refund, events: [event] })
      .success,
    true,
  );
  for (const events of [
    [event, event],
    [{ ...event, revision: 2 }],
    [{ ...event, payload: { amountKopeks: 200 } }],
  ])
    assert.equal(
      adminPaymentRefundDetailSchema.safeParse({ refund, events }).success,
      false,
    );
});

test("paid source conservation keeps held, spent, reserved and refunded money out of availability", () => {
  assert.equal(ownerPaymentSourceSchema.safeParse(source).success, true);
  assert.equal(
    ownerPaymentSourceSchema.safeParse({
      ...source,
      availableMicros: 19_999_999,
      spentMicros: 20_000_001,
      heldMicros: 30_000_000,
      refundReservedMicros: 10_000_000,
      refundedMicros: 20_000_000,
    }).success,
    true,
  );
  for (const patch of [
    { grossMicros: 0, availableMicros: 0 },
    { availableMicros: 100_000_001 },
    { availableMicros: 99_999_999, refundedMicros: 1 },
    { heldMicros: -1 },
    { kind: "gift" },
  ])
    assert.equal(
      ownerPaymentSourceSchema.safeParse({ ...source, ...patch }).success,
      false,
    );
  const adminSource = {
    ...source,
    userId: "1",
    providerPaymentId: otherId,
    merchantId: "synthetic-shop",
  };
  assert.equal(adminPaymentSourceSchema.safeParse(adminSource).success, true);
  assert.equal(ownerPaymentSourceSchema.safeParse(adminSource).success, false);
});

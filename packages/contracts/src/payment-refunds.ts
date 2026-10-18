import { z } from "zod";
import { creditUserIdSchema } from "./ai-credit.js";
import { CITYGO_MAX_AMOUNT_MICROS } from "./citygo-tariff.js";

// Money remains server-owned. A DTO, candidate provider ID, successful redirect
// or operator button is never proof of a payment/refund or NPD correction.
export const paymentRefundIdSchema = z.uuid();
const kopeks = z.number().int().min(1).max(1_000_000_000);
const micros = z.number().int().min(0).max(CITYGO_MAX_AMOUNT_MICROS);
const revision = z.number().int().min(1).max(2_147_483_647);
const merchant = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const paymentRefundStatusSchema = z.enum([
  "reserved",
  "unknown",
  "pending",
  "succeeded",
  "canceled",
  "review_required",
]);
export const paymentRefundReviewReasonSchema = z.enum([
  "dispatch_result_unknown",
  "provider_transport_failure",
  "provider_request_rejected",
  "provider_mismatch",
  "provider_refund_conflict",
  "payment_mismatch",
  "manual_review_required",
  "replay_window_expired",
  "configuration_mismatch",
  "external_refund_drift",
]);
// 100 kopeks is the current technical test threshold, not a legal minimum.
export const createPaymentRefundSchema = z.strictObject({
  requestId: z.uuid(),
  paymentOperationId: z.uuid(),
  amountKopeks: kopeks.min(100),
});
export type CreatePaymentRefundInput = z.infer<
  typeof createPaymentRefundSchema
>;
export const submitPaymentRefundSchema = z.strictObject({});
export const reconcilePaymentRefundSchema = z.strictObject({
  candidateProviderRefundId: z.uuid().optional(),
});
export type ReconcilePaymentRefundInput = z.infer<
  typeof reconcilePaymentRefundSchema
>;
export const paymentRefundListQuerySchema = z.strictObject({
  status: paymentRefundStatusSchema.optional(),
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type PaymentRefundListQuery = z.infer<
  typeof paymentRefundListQuerySchema
>;
export const adminPaymentSourceQuerySchema = z.strictObject({
  userId: creditUserIdSchema,
});

const commonRefund = {
  id: paymentRefundIdSchema,
  paymentOperationId: z.uuid(),
  amountKopeks: kopeks,
  test: z.boolean(),
  status: paymentRefundStatusSchema,
  revision,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
export const ownerPaymentRefundSchema = z.strictObject(commonRefund);
export type OwnerPaymentRefund = z.infer<typeof ownerPaymentRefundSchema>;
export const adminPaymentRefundSchema = z
  .strictObject({
    ...commonRefund,
    requestId: z.uuid(),
    userId: creditUserIdSchema,
    providerPaymentId: z.uuid(),
    merchantId: merchant,
    providerRefundId: z.uuid().nullable(),
    attemptCount: z.number().int().min(0).max(2_147_483_647),
    lastAttemptAt: z.iso.datetime().nullable(),
    reviewReason: paymentRefundReviewReasonSchema.nullable(),
  })
  .refine(
    (value) =>
      !["pending", "succeeded", "canceled"].includes(value.status) ||
      value.providerRefundId !== null,
  )
  .refine(
    (value) => (value.attemptCount === 0) === (value.lastAttemptAt === null),
  )
  .refine(
    (value) =>
      value.status !== "reserved" ||
      (value.attemptCount === 0 && value.providerRefundId === null),
  )
  .refine((value) => value.status !== "unknown" || value.attemptCount > 0);
export type AdminPaymentRefund = z.infer<typeof adminPaymentRefundSchema>;
export const paymentRefundEventSchema = z
  .strictObject({
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    action: z.enum([
      "reserved",
      "dispatch_started",
      "provider_observed",
      "review_required",
      "dispatch_failed",
    ]),
    actorUserId: creditUserIdSchema.nullable(),
    revision,
    createdAt: z.iso.datetime(),
    payload: z.strictObject({
      providerStatus: z.enum(["pending", "succeeded", "canceled"]).optional(),
      providerRefundId: z.uuid().optional(),
      reason: paymentRefundReviewReasonSchema.optional(),
      amountKopeks: kopeks.optional(),
      observation: z.enum(["create_response", "server_get"]).optional(),
    }),
  })
  .refine((event) => {
    const payload = event.payload;
    const only = (...keys: string[]) =>
      Object.keys(payload).every((key) => keys.includes(key));
    switch (event.action) {
      case "reserved":
        return (
          event.actorUserId !== null &&
          payload.amountKopeks !== undefined &&
          only("amountKopeks")
        );
      case "dispatch_started":
        return event.actorUserId !== null && Object.keys(payload).length === 0;
      case "provider_observed":
        return (
          event.actorUserId === null &&
          payload.providerRefundId !== undefined &&
          payload.providerStatus !== undefined &&
          payload.observation !== undefined &&
          only("providerRefundId", "providerStatus", "observation")
        );
      case "review_required":
        return payload.reason !== undefined && only("reason");
      case "dispatch_failed":
        return (
          event.actorUserId === null &&
          payload.reason !== undefined &&
          (payload.observation === undefined ||
            payload.observation === "server_get") &&
          only("reason", "observation")
        );
    }
  });
export type PaymentRefundEvent = z.infer<typeof paymentRefundEventSchema>;
export const adminPaymentRefundListSchema = z.strictObject({
  refunds: z.array(adminPaymentRefundSchema).max(100),
  nextAfter: z.uuid().nullable(),
});
export const adminPaymentRefundDetailSchema = z
  .strictObject({
    refund: adminPaymentRefundSchema,
    events: z.array(paymentRefundEventSchema).max(200),
  })
  .refine(
    (value) =>
      new Set(value.events.map((event) => event.sequence)).size ===
        value.events.length &&
      value.events.every(
        (event) =>
          event.revision <= value.refund.revision &&
          (event.action !== "reserved" ||
            event.payload.amountKopeks === value.refund.amountKopeks),
      ),
  );
export type AdminPaymentRefundDetail = z.infer<
  typeof adminPaymentRefundDetailSchema
>;
export const ownerPaymentRefundListSchema = z.strictObject({
  refunds: z.array(ownerPaymentRefundSchema).max(100),
});

const commonSource = {
  sourceOperationId: z.uuid(),
  test: z.boolean(),
  grossMicros: micros,
  availableMicros: micros,
  spentMicros: micros,
  heldMicros: micros,
  refundReservedMicros: micros,
  refundedMicros: micros,
  createdAt: z.iso.datetime(),
};
function sourceTotals(value: z.infer<typeof sourceBase>) {
  return (
    value.grossMicros > 0 &&
    value.grossMicros % 10_000 === 0 &&
    value.availableMicros +
      value.spentMicros +
      value.heldMicros +
      value.refundReservedMicros +
      value.refundedMicros ===
      value.grossMicros &&
    value.refundReservedMicros % 10_000 === 0 &&
    value.refundedMicros % 10_000 === 0
  );
}
const sourceBase = z.strictObject(commonSource);
export const ownerPaymentSourceSchema = sourceBase.refine(sourceTotals);
export type OwnerPaymentSource = z.infer<typeof ownerPaymentSourceSchema>;
export const adminPaymentSourceSchema = z
  .strictObject({
    ...commonSource,
    userId: creditUserIdSchema,
    providerPaymentId: z.uuid(),
    merchantId: merchant,
  })
  .refine(sourceTotals);
export type AdminPaymentSource = z.infer<typeof adminPaymentSourceSchema>;
export const ownerPaymentSourceListSchema = z.strictObject({
  sources: z.array(ownerPaymentSourceSchema).max(100),
  truncated: z.boolean(),
});
export const adminPaymentSourceListSchema = z.strictObject({
  sources: z.array(adminPaymentSourceSchema).max(100),
  truncated: z.boolean(),
});

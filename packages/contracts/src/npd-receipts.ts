import { z } from "zod";
import { creditUserIdSchema } from "./ai-credit.js";

// Manual operator reports, never authenticated FNS evidence or a payment API.
export const npdReceiptTaskIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const money = z.number().int().min(0).max(1_000_000_000);
const externalId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const revision = z.number().int().min(1).max(2_147_483_647);
export const npdReceiptEvidenceUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "lknpd.nalog.ru" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        url.pathname !== "/"
      );
    } catch {
      return false;
    }
  })
  .transform((value) => new URL(value).href);
export const npdReceiptReviewReasonSchema = z.enum([
  "registration_uncertain",
  "delivery_uncertain",
  "correction_uncertain",
]);
const receipt = z.strictObject({
  receiptId: externalId,
  receiptUrl: npdReceiptEvidenceUrlSchema,
  amountKopeks: money.positive(),
});
const commandBase = {
  requestId: npdReceiptTaskIdSchema,
  expectedRevision: revision,
};
export const npdReceiptCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...commandBase, action: z.literal("claim") }),
  z.strictObject({
    ...commandBase,
    action: z.literal("register"),
    ...receipt.shape,
    operatorReported: z.literal(true),
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("delivery"),
    receiptEvidenceId: npdReceiptTaskIdSchema,
    channel: z.enum(["email", "other_manual"]),
    operatorReported: z.literal(true),
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("review"),
    reason: npdReceiptReviewReasonSchema,
  }),
  z.strictObject({
    ...commandBase,
    action: z.literal("correction"),
    refundSnapshotKopeks: money.positive(),
    canceledReceiptId: externalId,
    evidenceUrl: npdReceiptEvidenceUrlSchema,
    replacement: receipt.nullable(),
    operatorReported: z.literal(true),
  }),
]);
export type NpdReceiptCommand = z.infer<typeof npdReceiptCommandSchema>;
export const npdReceiptListQuerySchema = z.strictObject({
  status: z
    .enum(["pending", "registered", "correction_required", "review"])
    .optional(),
  after: npdReceiptTaskIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type NpdReceiptListQuery = z.infer<typeof npdReceiptListQuerySchema>;

const task = {
  id: npdReceiptTaskIdSchema,
  userId: creditUserIdSchema,
  paymentId: externalId,
  paymentProvider: z.literal("yookassa"),
  amountKopeks: money.positive(),
  cumulativeRefundedKopeks: money,
  remainingIncomeKopeks: money,
  revision,
  registrationStatus: z.enum(["pending", "operator_reported"]),
  deliveryStatus: z.enum(["pending", "operator_reported"]),
  correctionStatus: z.enum(["not_required", "required", "operator_reported"]),
  activeEvidenceId: npdReceiptTaskIdSchema.nullable(),
  activeReceiptId: externalId.nullable(),
  activeReceiptUrl: npdReceiptEvidenceUrlSchema.nullable(),
  reviewReason: npdReceiptReviewReasonSchema.nullable(),
  observedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
const ownerTaskBase = z.strictObject(task);
function validState(value: z.infer<typeof ownerTaskBase>) {
  return (
    value.cumulativeRefundedKopeks <= value.amountKopeks &&
    value.remainingIncomeKopeks ===
      value.amountKopeks - value.cumulativeRefundedKopeks &&
    (value.correctionStatus === "not_required") ===
      (value.cumulativeRefundedKopeks === 0) &&
    (value.registrationStatus === "pending"
      ? value.activeEvidenceId === null &&
        value.activeReceiptId === null &&
        value.activeReceiptUrl === null &&
        value.deliveryStatus === "pending"
      : value.activeEvidenceId !== null &&
        value.activeReceiptUrl !== null &&
        (value.activeReceiptId !== null ||
          (value.correctionStatus === "operator_reported" &&
            value.remainingIncomeKopeks === 0))) &&
    (value.correctionStatus !== "operator_reported" ||
      value.registrationStatus === "operator_reported") &&
    (value.correctionStatus !== "operator_reported" ||
      (value.remainingIncomeKopeks === 0
        ? value.activeReceiptId === null
        : value.activeReceiptId !== null)) &&
    (value.deliveryStatus !== "operator_reported" ||
      (value.registrationStatus === "operator_reported" &&
        value.activeEvidenceId !== null &&
        value.correctionStatus !== "required" &&
        value.reviewReason !== "delivery_uncertain"))
  );
}
export const ownerNpdReceiptTaskSchema = ownerTaskBase.refine(validState);
export type OwnerNpdReceiptTask = z.infer<typeof ownerNpdReceiptTaskSchema>;
export const adminNpdReceiptTaskSchema = z
  .strictObject({
    ...task,
    buyerEmail: z.email().max(254).nullable(),
    claimedByUserId: creditUserIdSchema.nullable(),
  })
  .refine(validState)
  .refine(
    (value) =>
      value.registrationStatus !== "operator_reported" ||
      value.claimedByUserId !== null,
  );
export type AdminNpdReceiptTask = z.infer<typeof adminNpdReceiptTaskSchema>;
const refundEvent = z.strictObject({
  action: z.literal("refund_observed"),
  providerRefundId: externalId,
  amountKopeks: money.positive(),
  cumulativeRefundedKopeks: money.positive(),
});
export const npdReceiptEventSchema = z
  .strictObject({
    requestId: npdReceiptTaskIdSchema,
    action: z.enum([
      "claim",
      "register",
      "delivery",
      "review",
      "correction",
      "refund_observed",
    ]),
    actorUserId: creditUserIdSchema.nullable(),
    revision,
    payload: z.union([npdReceiptCommandSchema, refundEvent]),
    createdAt: z.iso.datetime(),
  })
  .refine((value) => {
    if (value.action !== value.payload.action) return false;
    if (value.payload.action === "refund_observed")
      return (
        value.actorUserId === null &&
        value.payload.cumulativeRefundedKopeks >= value.payload.amountKopeks
      );
    return (
      value.actorUserId !== null &&
      value.requestId === value.payload.requestId &&
      value.revision === value.payload.expectedRevision + 1
    );
  });
export type NpdReceiptEvent = z.infer<typeof npdReceiptEventSchema>;
export const adminNpdReceiptListSchema = z.strictObject({
  tasks: z.array(adminNpdReceiptTaskSchema).max(100),
  nextAfter: npdReceiptTaskIdSchema.nullable(),
});
export const adminNpdReceiptDetailSchema = z.strictObject({
  task: adminNpdReceiptTaskSchema,
  events: z.array(npdReceiptEventSchema).max(200),
});
export type AdminNpdReceiptDetail = z.infer<typeof adminNpdReceiptDetailSchema>;
export const ownerNpdReceiptListSchema = z.strictObject({
  tasks: z.array(ownerNpdReceiptTaskSchema).max(100),
});

import { z } from "zod";
import { creditUserIdSchema } from "./ai-credit.js";

const common = {
  requestId: z.uuid(),
  expectedRevision: z.number().int().min(1).max(2_147_483_646),
};
// No merchant, runtime binding, heartbeat timestamp or tax deadline is supplied
// by a browser. The responsibility acknowledgement is a report, not tax proof.
export const paymentAdmissionCommandSchema = z.union([
  z.strictObject({
    ...common,
    action: z.literal("open"),
    mode: z.literal("continuous"),
    manualNpdResponsibilityAccepted: z.literal(true),
  }),
  z.strictObject({
    ...common,
    action: z.literal("open"),
    mode: z.literal("lease"),
    leaseSeconds: z.number().int().min(1).max(3600).default(900),
    manualNpdResponsibilityAccepted: z.boolean().default(false),
  }),
  z.strictObject({ ...common, action: z.literal("close") }),
  z.strictObject({
    ...common,
    action: z.literal("set_reconciliation"),
    enabled: z.boolean(),
  }),
]);
export const paymentAdmissionStateSchema = z.strictObject({
  revision: z.number().int().positive(),
  acceptingNewCheckouts: z.boolean(),
  reconciliationEnabled: z.boolean(),
  mode: z.enum(["closed", "lease", "continuous"]),
  ownerUserId: creditUserIdSchema.nullable(),
  leaseUntil: z.iso.datetime().nullable(),
  manualNpdResponsibilityAccepted: z.boolean(),
  reconciliationCheckedAt: z.iso.datetime().nullable(),
  reconciliationOk: z.boolean(),
  runtimeBindingMatches: z.boolean(),
  available: z.boolean(),
  reason: z
    .enum([
      "closed",
      "binding_mismatch",
      "operator_inactive",
      "lease_expired",
      "reconciliation_disabled",
      "reconciliation_unhealthy",
      "reconciliation_stale",
    ])
    .nullable(),
});
export const paymentAdmissionStatusSchema = paymentAdmissionStateSchema.extend({
  npdBacklog: z.strictObject({
    pendingRegistration: z.number().int().nonnegative(),
    pendingDelivery: z.number().int().nonnegative(),
    requiredCorrection: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    oldestObservedAt: z.iso.datetime().nullable(),
  }),
});
export const paymentAdmissionUserStatusSchema = z.strictObject({
  available: z.boolean(),
});
export type PaymentAdmissionCommand = z.infer<
  typeof paymentAdmissionCommandSchema
>;
export type PaymentAdmissionState = z.infer<typeof paymentAdmissionStateSchema>;
export type PaymentAdmissionStatus = z.infer<
  typeof paymentAdmissionStatusSchema
>;
export type PaymentAdmissionUserStatus = z.infer<
  typeof paymentAdmissionUserStatusSchema
>;

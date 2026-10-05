import { z } from "zod";
import { entityIdSchema } from "./protocol.js";
import {
  r1AiRouteReferenceSchema,
  r1NoticeReferenceSchema,
  r1PermissionCommandSchema,
  r1PermissionScopeSchema,
  type R1PermissionScope,
} from "./r1-permissions.js";

// Synthetic harness protocol ONLY. No real consent, admission or production
// response compatibility promise. All objects are strict, not strip/coerce.
export const r1SyntheticOwnerSchema = entityIdSchema.refine(
  (value) => value === value.trim(),
);
const revision = z.number().int().min(1).max(2147483647);
const canonicalUuid = z.uuid().refine((value) => value === value.toLowerCase());
export const r1SyntheticNoticeDefinitionSchema = z
  .strictObject({
    mode: z.literal("synthetic_only"),
    scope: r1PermissionScopeSchema,
    version: r1NoticeReferenceSchema.shape.version,
    body: z
      .string()
      .min(1)
      .max(16384)
      .refine((value) => value.trim().length > 0),
    routeDisclosureId: r1AiRouteReferenceSchema.shape.disclosureId.nullable(),
    status: z.enum(["draft_fixture", "approved_fixture", "withdrawn_fixture"]),
  })
  .superRefine((notice, context) => {
    if (
      (notice.scope === "citygo_context" &&
        notice.routeDisclosureId !== null) ||
      (notice.scope === "ai_transfer" &&
        notice.status === "approved_fixture" &&
        notice.routeDisclosureId === null)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid synthetic route binding",
      });
  });
export const r1SyntheticNoticeSchema = z
  .strictObject({
    reference: r1NoticeReferenceSchema,
    definition: r1SyntheticNoticeDefinitionSchema,
  })
  .superRefine((notice, context) => {
    if (notice.reference.version !== notice.definition.version)
      context.addIssue({
        code: "custom",
        message: "Synthetic notice version mismatch",
      });
    // Hash/full-body identity is additionally verified by the server registry;
    // shape validation alone does not prove authenticity or operator approval.
  });
export const r1SyntheticPermissionReceiptSchema = z
  .strictObject({
    eventId: canonicalUuid,
    ownerId: r1SyntheticOwnerSchema,
    scope: r1PermissionScopeSchema,
    revision,
    configurationRevision: revision,
    recordedAt: z.iso.datetime(),
    command: r1PermissionCommandSchema,
  })
  .superRefine((receipt, context) => {
    if (
      receipt.command.scope !== receipt.scope ||
      receipt.command.expectedRevision + 1 !== receipt.revision ||
      receipt.command.requestId !== receipt.command.requestId.toLowerCase()
    )
      context.addIssue({
        code: "custom",
        message: "Invalid synthetic receipt binding",
      });
  });
export const r1SyntheticPermissionRejectionCodeSchema = z.enum([
  "SYNTHETIC_ONLY",
  "UNAUTHENTICATED",
  "INVALID_COMMAND",
  "INVALID_DECISION",
  "OWNER_OR_SCOPE_MISMATCH",
  "REVISION_CONFLICT",
  "REVISION_EXHAUSTED",
  "POLICY_UNAVAILABLE",
  "POLICY_NOT_APPROVED",
  "NOTICE_CHANGED",
  "ROUTE_UNAVAILABLE",
  "ROUTE_CHANGED",
  "STORE_NOT_READY",
  "STORED_DATA_INVALID",
  "WRITE_NOT_COMMITTED",
  "REQUEST_ID_REUSED",
  "STORAGE_QUOTA_EXCEEDED",
]);
export const r1SyntheticPermissionWriteResponseSchema = z.union([
  z.strictObject({
    status: z.literal("synthetic_recorded"),
    replayed: z.boolean(),
    receipt: r1SyntheticPermissionReceiptSchema,
  }),
  z.strictObject({
    status: z.literal("rejected"),
    code: r1SyntheticPermissionRejectionCodeSchema,
  }),
  z.strictObject({
    status: z.literal("unconfirmed"),
    code: z.literal("STORAGE_UNAVAILABLE"),
    retry: z.literal("same_command"),
  }),
]);
export function r1SyntheticPermissionRejectionHttpStatus(
  code: z.infer<typeof r1SyntheticPermissionRejectionCodeSchema>,
): number {
  return code === "INVALID_COMMAND"
    ? 400
    : code === "UNAUTHENTICATED"
      ? 401
      : code === "STORAGE_QUOTA_EXCEEDED"
        ? 429
        : [
              "STORE_NOT_READY",
              "STORED_DATA_INVALID",
              "SYNTHETIC_ONLY",
              "WRITE_NOT_COMMITTED",
            ].includes(code)
          ? 503
          : 409;
}
const availability = z.enum([
  "available_fixture",
  "notice_unavailable",
  "notice_not_approved",
  "route_unavailable",
  "route_notice_mismatch",
]);
const resolution = z.enum([
  "not_decided",
  "revoked",
  "current_fixture_grant",
  "requires_new_action",
]);
type ProjectionInput = {
  scope: R1PermissionScope;
  lastDecision: z.infer<typeof r1SyntheticPermissionReceiptSchema> | null;
  notice: z.infer<typeof r1SyntheticNoticeSchema> | null;
  route: z.infer<typeof r1AiRouteReferenceSchema> | null;
};
// Pure projection of validated synthetic facts. Never an AI admission check.
export function projectR1SyntheticPermissionScope(input: ProjectionInput): {
  grantAvailability: z.infer<typeof availability>;
  resolution: z.infer<typeof resolution>;
} {
  const { scope, notice, route, lastDecision } = input;
  const grantAvailability = !notice
    ? "notice_unavailable"
    : notice.definition.status !== "approved_fixture"
      ? "notice_not_approved"
      : scope === "ai_transfer" && !route
        ? "route_unavailable"
        : scope === "ai_transfer" &&
            notice.definition.routeDisclosureId !== route?.disclosureId
          ? "route_notice_mismatch"
          : "available_fixture";
  const action = lastDecision?.command;
  const matches =
    action?.action === "grant" &&
    grantAvailability === "available_fixture" &&
    action.notice.id === notice?.reference.id &&
    action.notice.version === notice.reference.version &&
    (action.scope !== "ai_transfer" ||
      (action.route.revision === route?.revision &&
        action.route.disclosureId === route.disclosureId));
  return {
    grantAvailability,
    resolution: !action
      ? "not_decided"
      : action.action === "revoke"
        ? "revoked"
        : matches
          ? "current_fixture_grant"
          : "requires_new_action",
  };
}
export const r1SyntheticPermissionScopeStateSchema = z
  .strictObject({
    scope: r1PermissionScopeSchema,
    revision: z.number().int().min(0).max(2147483647),
    lastDecision: r1SyntheticPermissionReceiptSchema.nullable(),
    notice: r1SyntheticNoticeSchema.nullable(),
    route: r1AiRouteReferenceSchema.nullable(),
    grantAvailability: availability,
    resolution,
  })
  .superRefine((state, context) => {
    const projected = projectR1SyntheticPermissionScope(state);
    if (
      state.revision !== (state.lastDecision?.revision ?? 0) ||
      (state.lastDecision && state.lastDecision.scope !== state.scope) ||
      (state.notice && state.notice.definition.scope !== state.scope) ||
      (state.scope === "citygo_context" && state.route !== null) ||
      state.grantAvailability !== projected.grantAvailability ||
      state.resolution !== projected.resolution
    )
      context.addIssue({
        code: "custom",
        message: "Invalid synthetic state binding",
      });
  });
export const r1SyntheticPermissionSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mode: z.literal("synthetic_only"),
    status: z.literal("synthetic_snapshot"),
    ownerId: r1SyntheticOwnerSchema,
    configurationRevision: revision,
    scopes: z.strictObject({
      citygo_context: r1SyntheticPermissionScopeStateSchema,
      ai_transfer: r1SyntheticPermissionScopeStateSchema,
    }),
  })
  .superRefine((snapshot, context) => {
    for (const scope of ["citygo_context", "ai_transfer"] as const) {
      const state = snapshot.scopes[scope];
      if (
        state.scope !== scope ||
        (state.lastDecision &&
          (state.lastDecision.ownerId !== snapshot.ownerId ||
            state.lastDecision.configurationRevision >
              snapshot.configurationRevision))
      )
        context.addIssue({
          code: "custom",
          message: "Invalid synthetic owner/configuration binding",
        });
    }
  });
export const r1SyntheticPermissionReadResponseSchema = z.union([
  r1SyntheticPermissionSnapshotSchema,
  z.strictObject({
    status: z.literal("rejected"),
    code: z.enum([
      "SYNTHETIC_ONLY",
      "UNAUTHENTICATED",
      "STORE_NOT_READY",
      "STORED_DATA_INVALID",
    ]),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.literal("STORAGE_UNAVAILABLE"),
  }),
]);
export type R1SyntheticPermissionSnapshot = z.infer<
  typeof r1SyntheticPermissionSnapshotSchema
>;
export type R1SyntheticPermissionScopeState = z.infer<
  typeof r1SyntheticPermissionScopeStateSchema
>;
export type R1SyntheticPermissionReadResponse = z.infer<
  typeof r1SyntheticPermissionReadResponseSchema
>;

// Test-only historical lookup. "not_recorded_at_read" neither cancels nor
// settles an older in-flight write. A found receipt is never current admission.
export const r1SyntheticPermissionLookupResponseSchema = z.union([
  z.strictObject({
    status: z.literal("synthetic_recorded"),
    replayed: z.literal(true),
    receipt: r1SyntheticPermissionReceiptSchema,
  }),
  z.strictObject({
    status: z.literal("not_recorded_at_read"),
    ownerId: r1SyntheticOwnerSchema,
    scope: r1PermissionScopeSchema,
    requestId: canonicalUuid,
  }),
  z.strictObject({
    status: z.literal("rejected"),
    code: z.enum([
      "SYNTHETIC_ONLY",
      "UNAUTHENTICATED",
      "INVALID_COMMAND",
      "STORE_NOT_READY",
      "STORED_DATA_INVALID",
    ]),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.literal("STORAGE_UNAVAILABLE"),
  }),
]);
export type R1SyntheticPermissionLookupResponse = z.infer<
  typeof r1SyntheticPermissionLookupResponseSchema
>;

import { z } from "zod";
import { aiPolicyIdSchema } from "./ai-access.js";

// Candidate wire DTOs; used only by the isolated synthetic harness so far.
// Not connected to real consent, data processing or AI admission.
// Parsing neither approves a policy nor proves an authenticated user action.
export const r1PermissionScopeSchema = z.enum([
  "citygo_context",
  "ai_transfer",
]);

// Reference to the complete, approved notice in a future server-owned registry.
// The existing technical AiPolicy hash is NOT an approved R1 notice ID.
export const r1NoticeReferenceSchema = z.strictObject({
  id: aiPolicyIdSchema.length(64),
  version: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/)
    .refine(
      (value) => value === value.trim(),
      "Notice version must be canonical",
    ),
});

// Bind the AI action to the routing revision AND the public technical snapshot.
// The notice reference above separately binds the full operator-approved text.
export const r1AiRouteReferenceSchema = z.strictObject({
  revision: z.number().int().min(1).max(2147483647),
  disclosureId: aiPolicyIdSchema.length(64),
});

const command = {
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  // Per-owner/per-scope decision revision. Zero means no decision yet, not a
  // wildcard; the future handler must compare it under the transaction lock.
  expectedRevision: z.number().int().min(0).max(2147483647),
};

export const r1ContextPermissionCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...command,
    scope: z.literal("citygo_context"),
    action: z.literal("grant"),
    notice: r1NoticeReferenceSchema,
  }),
  z.strictObject({
    ...command,
    scope: z.literal("citygo_context"),
    action: z.literal("revoke"),
  }),
]);

export const r1AiPermissionCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...command,
    scope: z.literal("ai_transfer"),
    action: z.literal("grant"),
    notice: r1NoticeReferenceSchema,
    route: r1AiRouteReferenceSchema,
  }),
  // Revocation must not require accepting/loading the current notice or route.
  z.strictObject({
    ...command,
    scope: z.literal("ai_transfer"),
    action: z.literal("revoke"),
  }),
]);

// Exactly one explicit action in one scope. No bundled permissions, human-help
// prerequisite, marketing switch, user ID, client timestamp or policy payload.
export const r1PermissionCommandSchema = z.union([
  r1ContextPermissionCommandSchema,
  r1AiPermissionCommandSchema,
]);

export type R1PermissionScope = z.infer<typeof r1PermissionScopeSchema>;
export type R1NoticeReference = z.infer<typeof r1NoticeReferenceSchema>;
export type R1AiRouteReference = z.infer<typeof r1AiRouteReferenceSchema>;
export type R1ContextPermissionCommand = z.infer<
  typeof r1ContextPermissionCommandSchema
>;
export type R1AiPermissionCommand = z.infer<typeof r1AiPermissionCommandSchema>;
export type R1PermissionCommand = z.infer<typeof r1PermissionCommandSchema>;

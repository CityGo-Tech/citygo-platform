import { z } from "zod";
import { agentKeySchema, profileSchema } from "./platform.js";
import {
  entityIdSchema as id,
  entityRevisionSchema as revision,
  entityRefSchema as ref,
} from "./protocol.js";

// Candidate R1 resource metadata, NOT endpoints or current database rows.
// Do not coerce legacy rows into these shapes; CG-009/012 add persistence.
const versioned = z.object({ schemaVersion: z.literal(1), id, revision });
const owned = versioned.extend({ ownerId: id });
const dateTime = z.iso.datetime({ offset: true });
const references = z.array(ref).max(100);
const uniqueReferences = references.refine(
  (items) => new Set(items.map((item) => item.id)).size === items.length,
  "Duplicate resource reference",
);
export const r1ProfileSchema = owned.extend({
  // AI consent is a separate policy grant, never a condition for human help.
  data: profileSchema.omit({ aiConsent: true }),
});
export const r1PlanSchema = owned.extend({
  profile: ref,
  status: z.enum(["active", "superseded"]),
  quests: uniqueReferences,
});
export const questStateSchema = z.enum([
  "locked",
  "available",
  "in_progress",
  "completed",
]);
export const r1QuestSchema = owned.extend({
  plan: ref,
  definition: ref,
  state: questStateSchema,
  xpReward: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const r1ArtifactMetadataSchema = owned.extend({
  plan: ref,
  quest: ref,
  kind: z.enum(["housing_brief", "viewing_checklist"]),
  sources: uniqueReferences,
  createdAt: dateTime,
});
// Content and confirmation/evidence rules require the CG-010 expert decision.
// Metadata alone MUST NOT authorize completion or XP.
export const r1RunSchema = owned.extend({
  threadId: id,
  requestId: z.uuid(),
  plan: ref,
  quest: ref,
  agentKey: agentKeySchema,
  status: z.enum(["rejected", "running", "complete", "interrupted", "failed"]),
  artifacts: uniqueReferences,
});
export const r1SourceSchema = versioned.extend({
  kind: z.enum(["synthetic", "reference"]),
  title: z.string().trim().min(1).max(300),
  url: z.url({ protocol: /^https?$/ }).nullable(),
  jurisdiction: z.string().trim().min(1).max(100),
  scope: z.string().trim().min(1).max(500),
  reviewedAt: dateTime.nullable(),
  validUntil: dateTime.nullable(),
  status: z.enum(["draft", "reviewed", "withdrawn"]),
});
export const r1HumanCaseSchema = owned.extend({
  // A case can exist before a plan or an AI conversation.
  plan: ref.nullable(),
  threadId: id.nullable(),
  status: z.enum([
    "submitted",
    "accepted",
    "waiting_user",
    "resolved",
    "closed",
  ]),
  operatorId: id.nullable(),
  createdAt: dateTime,
  updatedAt: dateTime,
});
// Bounded pagination and CAS commands shared by future R1 handlers. Server-side
// ownership, graph integrity, freshness and transitions remain mandatory.
export const r1PageRequestSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
export const r1CommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    expectedVersion: revision,
  })
  .strict();
export type R1Profile = z.infer<typeof r1ProfileSchema>;
export type R1Plan = z.infer<typeof r1PlanSchema>;
export type R1Quest = z.infer<typeof r1QuestSchema>;
export type R1ArtifactMetadata = z.infer<typeof r1ArtifactMetadataSchema>;
export type R1Run = z.infer<typeof r1RunSchema>;
export type R1Source = z.infer<typeof r1SourceSchema>;
export type R1HumanCase = z.infer<typeof r1HumanCaseSchema>;

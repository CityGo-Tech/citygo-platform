import { z } from "zod";
import {
  r1HousingBriefDraftSchema,
  r1HousingIdSchema,
  r1HousingRevisionSchema,
} from "./housing-v1.js";

// Additive synthetic HTTP protocol. Persisted content stays pinned to v1.
// These DTOs authorize neither real-data processing nor completion/XP.
const plan = z.strictObject({
  id: r1HousingIdSchema,
  version: r1HousingRevisionSchema,
});
const queryInteger = (max: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .max(10)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));
const planQuery = {
  planId: r1HousingIdSchema,
  planVersion: queryInteger(2147483647),
};
export const housingRecoveryQuerySchema = z.strictObject(planQuery);
export const housingListQuerySchema = z.strictObject({
  ...planQuery,
  limit: queryInteger(50).optional(),
  beforeId: r1HousingIdSchema.optional(),
});
export const housingGetQuerySchema = z.strictObject({
  revision: queryInteger(2147483647).optional(),
});
export const housingHistoryQuerySchema = z.strictObject({
  limit: queryInteger(50).optional(),
  beforeRevision: queryInteger(2147483647).optional(),
});
export const housingParamsSchema = z.strictObject({ id: r1HousingIdSchema });
export const housingSnapshotResponseSchema = z.strictObject({
  id: r1HousingIdSchema,
  revision: r1HousingRevisionSchema,
  plan,
  content: r1HousingBriefDraftSchema,
});
export const housingSelectionItemSchema = z.strictObject({
  id: r1HousingIdSchema,
  revision: r1HousingRevisionSchema,
  plan,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const housingListResponseSchema = z.strictObject({
  items: z.array(housingSelectionItemSchema).max(50),
  nextBeforeId: r1HousingIdSchema.nullable(),
});
export const housingRecoveryResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("recovered"),
    brief: housingSnapshotResponseSchema,
  }),
  z.strictObject({ status: z.literal("selection_required") }),
]);
export const housingHistoryResponseSchema = z.strictObject({
  items: z.array(housingSnapshotResponseSchema).max(50),
  nextBeforeRevision: r1HousingRevisionSchema.nullable(),
});

// Proposed technical caps for synthetic fixtures, NOT an approved pilot policy.
// Zero disables new writes; committed command replay and reads remain available.
export const housingStorageLimitsSchema = z.strictObject({
  briefsPerOwner: z.number().int().min(0).max(100).default(100),
  briefsPerPlan: z.number().int().min(0).max(10).default(10),
  commandsPerOwner: z.number().int().min(0).max(1000).default(1000),
  revisionsPerBrief: z.number().int().min(0).max(250).default(250),
  commandBytes: z.number().int().min(1).max(16384).default(16384),
  snapshotBytes: z.number().int().min(1).max(65536).default(65536),
});
export type HousingStorageLimits = z.infer<typeof housingStorageLimitsSchema>;

import { z } from "zod";
import {
  personalPlanIdSchema,
  personalPlanStatusSchema,
} from "./personal-plan.js";
import { planChecklistEntriesSchema } from "./plan-checklist.js";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const personalPlanHistoryQuerySchema = z.strictObject({
  before: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .pipe(revision)
    .optional(),
});
export const personalPlanHistoryEntrySchema = z.strictObject({
  revision,
  title: z.string().trim().min(1).max(120),
  details: z.string().trim().max(4000),
  status: personalPlanStatusSchema,
  checklist: planChecklistEntriesSchema,
  initialSnapshot: z.boolean(),
  recordedAt: z.iso.datetime({ offset: true }),
});
export const personalPlanHistoryPageSchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    itemId: personalPlanIdSchema,
    currentRevision: revision,
    entries: z.array(personalPlanHistoryEntrySchema).max(5),
    nextBefore: revision.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.entries.some(
        (entry, index) =>
          entry.revision > value.currentRevision ||
          (index > 0 && entry.revision >= value.entries[index - 1]!.revision),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["entries"],
        message: "History requires descending saved revisions",
      });
    if (
      value.nextBefore !== null &&
      value.nextBefore !== value.entries.at(-1)?.revision
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextBefore"],
        message: "History cursor must match its last revision",
      });
  });
export const restorePersonalPlanRevisionSchema = z
  .strictObject({
    expectedRevision: revision,
    revision,
  })
  .refine((value) => value.revision < value.expectedRevision, {
    message: "Выберите предыдущую сохранённую версию",
  });
export const personalPlanRestoreResultSchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    itemId: personalPlanIdSchema,
    restoredRevision: revision,
    entry: personalPlanHistoryEntrySchema,
  })
  .refine(
    (value) =>
      value.entry.revision > value.restoredRevision &&
      !value.entry.initialSnapshot,
  );
export type RestorePersonalPlanRevision = z.infer<
  typeof restorePersonalPlanRevisionSchema
>;
export type PersonalPlanRestoreResult = z.infer<
  typeof personalPlanRestoreResultSchema
>;
export type PersonalPlanHistoryEntry = z.infer<
  typeof personalPlanHistoryEntrySchema
>;
export type PersonalPlanHistoryPage = z.infer<
  typeof personalPlanHistoryPageSchema
>;

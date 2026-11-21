import { z } from "zod";
import { personalPlanIdSchema } from "./personal-plan.js";

const maxRevision = 2_147_483_647;
const revision = z.number().int().min(1).max(maxRevision);
const expectedRevision = z.number().int().min(0).max(maxRevision);
const criterion = z
  .string()
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value))
  .transform((value) => value.normalize("NFC").trim())
  .refine((value) => Array.from(value).length <= 100);

export const housingWorkspaceCriteriaSchema = z.strictObject({
  situation: z.enum(["searching", "oriented", "direct"]),
  city: criterion,
  commute: criterion,
  budgetRub: z.number().int().min(1).max(99_999_999).nullable(),
});
export const housingChecklistEntrySchema = z.enum([
  "payment",
  "contract",
  "inspection",
]);
const selected = z
  .array(housingChecklistEntrySchema)
  .max(housingChecklistEntrySchema.options.length)
  .refine((entries) => new Set(entries).size === entries.length)
  .transform((entries) =>
    housingChecklistEntrySchema.options.filter((id) => entries.includes(id)),
  );
const checklistContent = {
  planRevision: revision,
  selected,
  paymentChecked: z.boolean(),
};
const savedMetadata = {
  revision,
  updatedAt: z.iso.datetime(),
  requestId: z.uuid().transform((value) => value.toLowerCase()),
};

export const saveHousingPlanSchema = z.strictObject({
  expectedRevision,
  threadId: personalPlanIdSchema,
  criteria: housingWorkspaceCriteriaSchema,
  requestId: savedMetadata.requestId,
});
export const saveHousingChecklistSchema = z.strictObject({
  expectedRevision,
  ...checklistContent,
  requestId: savedMetadata.requestId,
});
export const confirmHousingChecklistSchema = z.strictObject({
  expectedRevision: revision,
  planRevision: revision,
  requestId: savedMetadata.requestId,
  reviewed: z.literal(true),
});
export const housingWorkspaceSchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    plan: z
      .strictObject({
        ...savedMetadata,
        threadId: personalPlanIdSchema,
        criteria: housingWorkspaceCriteriaSchema,
      })
      .nullable(),
    checklist: z
      .strictObject({
        ...savedMetadata,
        ...checklistContent,
        confirmedFromRevision: revision.optional(),
        paymentNeedsReview: z.literal(true).optional(),
      })
      .refine(
        ({ revision: current, confirmedFromRevision }) =>
          confirmedFromRevision === undefined ||
          confirmedFromRevision + 1 === current,
      )
      .nullable(),
  })
  .refine(
    (workspace) =>
      !workspace.checklist ||
      (workspace.plan !== null &&
        workspace.checklist.planRevision <= workspace.plan.revision),
  );

export type HousingWorkspace = z.infer<typeof housingWorkspaceSchema>;
export type HousingWorkspaceCriteria = z.infer<
  typeof housingWorkspaceCriteriaSchema
>;
export type HousingChecklistEntry = z.infer<typeof housingChecklistEntrySchema>;
export type SaveHousingPlan = z.infer<typeof saveHousingPlanSchema>;
export type SaveHousingChecklist = z.infer<typeof saveHousingChecklistSchema>;
export type ConfirmHousingChecklist = z.infer<
  typeof confirmHousingChecklistSchema
>;

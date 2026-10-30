import { z } from "zod";
import { personalPlanIdSchema } from "./personal-plan.js";
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (value) =>
        !value.includes("\0") &&
        !Array.from(value).some(
          (point) =>
            point.length === 1 &&
            point.charCodeAt(0) >= 0xd800 &&
            point.charCodeAt(0) <= 0xdfff,
        ),
      "Недопустимый символ",
    );
export const planChecklistEntrySchema = z.strictObject({
  id: z.uuid().toLowerCase(),
  title: text(120).min(1),
  details: text(1000),
  completed: z.boolean(),
});
export const planChecklistEntriesSchema = z
  .array(planChecklistEntrySchema)
  .max(20)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Повторяющийся пункт",
  );
export const savePlanChecklistSchema = z.strictObject({
  expectedRevision: revision,
  entries: planChecklistEntriesSchema,
});
export const planChecklistSchema = z.strictObject({
  userId: personalPlanIdSchema,
  itemId: personalPlanIdSchema,
  revision,
  entries: planChecklistEntriesSchema,
});
export type PlanChecklistEntry = z.infer<typeof planChecklistEntrySchema>;
export type PlanChecklist = z.infer<typeof planChecklistSchema>;
export type SavePlanChecklist = z.infer<typeof savePlanChecklistSchema>;

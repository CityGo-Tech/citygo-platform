import { z } from "zod";
import {
  personalPlanIdSchema,
  personalPlanItemSchema,
} from "./personal-plan.js";
import { planChecklistEntriesSchema } from "./plan-checklist.js";

export const PERSONAL_PLAN_EXPORT_MAX_BYTES = 6 * 1024 * 1024;
export const personalPlanExportItemSchema = personalPlanItemSchema.safeExtend({
  checklist: planChecklistEntriesSchema,
});
export const personalPlanExportSchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    generatedAt: z.iso.datetime({ offset: true }),
    items: z.array(personalPlanExportItemSchema).max(200),
  })
  .superRefine((value, ctx) => {
    if (
      value.items.every(
        (item) => personalPlanIdSchema.safeParse(item.id).success,
      ) &&
      value.items.some(
        (item, index) =>
          index > 0 && BigInt(value.items[index - 1]!.id) <= BigInt(item.id),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Export requires unique descending step IDs",
      });
    if (
      value.items.some((item) =>
        [item.title, item.details].some(
          (text) =>
            text.includes("\0") ||
            Array.from(text).some(
              (point) =>
                point.length === 1 &&
                point.charCodeAt(0) >= 0xd800 &&
                point.charCodeAt(0) <= 0xdfff,
            ),
        ),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Export requires valid Unicode text",
      });
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      PERSONAL_PLAN_EXPORT_MAX_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "Plan export exceeds the aggregate byte limit",
      });
  });
export type PersonalPlanExport = z.infer<typeof personalPlanExportSchema>;

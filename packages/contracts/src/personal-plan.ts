import { z } from "zod";
import { messageIdSchema } from "./message-favorites.js";

// New resources use canonical PostgreSQL bigint strings, without changing
// historical contracts whose end-anchor may accept a final line terminator.
export const personalPlanIdSchema = messageIdSchema.refine(
  (value) => value === value.trim(),
);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const title = z.string().trim().min(1).max(120);
const details = z.string().trim().max(4000);
export const personalPlanStatusSchema = z.enum(["pending", "completed"]);
export const personalPlanItemSchema = z.strictObject({
  id: personalPlanIdSchema,
  title,
  details,
  status: personalPlanStatusSchema,
  revision,
  source: z
    .strictObject({
      messageId: personalPlanIdSchema,
      threadId: personalPlanIdSchema,
      role: z.enum(["user", "assistant"]),
    })
    .nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const createPersonalPlanItemSchema = z.strictObject({
  operationId: z.uuid().toLowerCase(),
  sourceMessageId: personalPlanIdSchema.nullable(),
  title,
  details,
});
export const updatePersonalPlanItemSchema = z.strictObject({
  expectedRevision: revision,
  title,
  details,
  status: personalPlanItemSchema.shape.status,
});
export const removePersonalPlanItemSchema = z.strictObject({
  expectedRevision: revision,
});
export const personalPlanQuerySchema = z.strictObject({
  before: personalPlanIdSchema.optional(),
  status: personalPlanStatusSchema.optional(),
});
const count = z.number().int().min(0).max(200);
export const personalPlanSummarySchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    total: count,
    pending: count,
    completed: count,
  })
  .refine((value) => value.total === value.pending + value.completed, {
    message: "Plan totals must agree with the two statuses",
  });
export const personalPlanPageSchema = z
  .strictObject({
    userId: personalPlanIdSchema,
    items: z.array(personalPlanItemSchema).max(20),
    nextBefore: personalPlanIdSchema.nullable(),
  })
  .superRefine((page, ctx) => {
    // Sibling refinements can run after an invalid ID. Never allow BigInt to turn
    // safeParse into a throw on a malformed server payload.
    if (
      page.items.some(
        (item) => !personalPlanIdSchema.safeParse(item.id).success,
      )
    )
      return;
    if (
      page.items.some(
        (item, index) =>
          index > 0 && BigInt(page.items[index - 1]!.id) <= BigInt(item.id),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Plan items require unique descending IDs",
      });
    if (
      page.nextBefore !== null &&
      (page.items.length !== 20 || page.nextBefore !== page.items.at(-1)?.id)
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextBefore"],
        message: "The next page requires twenty items and their last ID",
      });
  });
export const personalPlanItemResultSchema = z.strictObject({
  userId: personalPlanIdSchema,
  item: personalPlanItemSchema,
});
export const personalPlanRemoveResultSchema = z.strictObject({
  userId: personalPlanIdSchema,
  itemId: personalPlanIdSchema,
  removed: z.literal(true),
});

export type PersonalPlanItem = z.infer<typeof personalPlanItemSchema>;
export type PersonalPlanStatus = z.infer<typeof personalPlanStatusSchema>;
export type PersonalPlanSummary = z.infer<typeof personalPlanSummarySchema>;
export type CreatePersonalPlanItem = z.infer<
  typeof createPersonalPlanItemSchema
>;
export type UpdatePersonalPlanItem = z.infer<
  typeof updatePersonalPlanItemSchema
>;
export type PersonalPlanPage = z.infer<typeof personalPlanPageSchema>;
export type PersonalPlanItemResult = z.infer<
  typeof personalPlanItemResultSchema
>;
export type PersonalPlanRemoveResult = z.infer<
  typeof personalPlanRemoveResultSchema
>;

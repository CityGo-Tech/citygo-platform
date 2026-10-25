import { z } from "zod";
import { personalPlanIdSchema } from "./personal-plan.js";

// Reuse canonical PostgreSQL bigint IDs; never coerce them through Number.
export const personalMemoryIdSchema = personalPlanIdSchema;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const label = z.string().trim().min(1).max(80);
const value = z.string().trim().min(1).max(800);

export const personalMemoryItemSchema = z.strictObject({
  id: personalMemoryIdSchema,
  label,
  value,
  revision,
  source: z.strictObject({
    messageId: personalMemoryIdSchema,
    threadId: personalMemoryIdSchema,
    role: z.enum(["user", "assistant"]),
  }),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const createPersonalMemoryItemSchema = z.strictObject({
  operationId: z.uuid().toLowerCase(),
  sourceMessageId: personalMemoryIdSchema,
  label,
  value,
  confirmed: z.literal(true),
});
export const updatePersonalMemoryItemSchema = z.strictObject({
  expectedRevision: revision,
  label,
  value,
  confirmed: z.literal(true),
});
export const removePersonalMemoryItemSchema = z.strictObject({
  expectedRevision: revision,
});
export const personalMemoryListSchema = z
  .strictObject({
    userId: personalMemoryIdSchema,
    items: z.array(personalMemoryItemSchema).max(20),
  })
  .superRefine((list, ctx) => {
    if (
      list.items.some(
        (item) => !personalMemoryIdSchema.safeParse(item.id).success,
      )
    )
      return;
    if (
      list.items.some(
        (item, index) =>
          index > 0 && BigInt(list.items[index - 1]!.id) <= BigInt(item.id),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Memory items require unique descending IDs",
      });
  });
export const personalMemoryItemResultSchema = z.strictObject({
  userId: personalMemoryIdSchema,
  item: personalMemoryItemSchema,
});
export const personalMemoryRemoveResultSchema = z.strictObject({
  userId: personalMemoryIdSchema,
  itemId: personalMemoryIdSchema,
  removed: z.literal(true),
});

export type PersonalMemoryItem = z.infer<typeof personalMemoryItemSchema>;
export type CreatePersonalMemoryItem = z.infer<
  typeof createPersonalMemoryItemSchema
>;
export type UpdatePersonalMemoryItem = z.infer<
  typeof updatePersonalMemoryItemSchema
>;
export type PersonalMemoryList = z.infer<typeof personalMemoryListSchema>;
export type PersonalMemoryItemResult = z.infer<
  typeof personalMemoryItemResultSchema
>;
export type PersonalMemoryRemoveResult = z.infer<
  typeof personalMemoryRemoveResultSchema
>;

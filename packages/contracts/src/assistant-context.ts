import { z } from "zod";
import { agentKeySchema } from "./platform.js";
import { conversationHistoryIdSchema } from "./conversation-history.js";

export const assistantContextInputSchema = z.strictObject({
  threadId: conversationHistoryIdSchema.nullable(),
  draft: z.string().max(4000),
});
export type AssistantContextInput = z.infer<typeof assistantContextInputSchema>;

export const assistantContextPreviewSchema = z
  .strictObject({
    userId: conversationHistoryIdSchema,
    threadId: conversationHistoryIdSchema.nullable(),
    generatedAt: z.iso.datetime({ offset: true }),
    profile: z.strictObject({
      targetCity: z.string().min(2).max(100).nullable(),
      monthlyBudget: z.number().int().min(5000).max(1000000).nullable(),
      moveTargetDate: z.iso.date().nullable(),
      household: z.enum(["solo", "couple", "family"]).nullable(),
    }),
    agentKey: agentKeySchema,
    closed: z.boolean(),
    draftIncluded: z.boolean(),
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["user", "assistant"]),
          content: z
            .string()
            .min(1)
            .max(1024 * 1024),
        }),
      )
      .max(18),
  })
  .superRefine((value, ctx) => {
    if (
      value.messages.length % 2 !== 0 ||
      value.messages.some(
        (row, index) =>
          row.role !== (index % 2 === 0 ? "user" : "assistant") ||
          !row.content.trim(),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Context requires complete conversation rounds",
      });
    if (value.threadId === null && (value.messages.length > 0 || value.closed))
      ctx.addIssue({
        code: "custom",
        path: ["threadId"],
        message: "No conversation was selected",
      });
  });
export type AssistantContextPreview = z.infer<
  typeof assistantContextPreviewSchema
>;

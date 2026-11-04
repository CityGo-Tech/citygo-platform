import { z } from "zod";
import { chatTextSchema } from "./chat-limits.js";
import { agentKeySchema } from "./platform.js";
import { conversationHistoryIdSchema } from "./conversation-history.js";
import { aiModeIdSchema, aiModeCatalogIdSchema } from "./ai-modes.js";

export const assistantContextInputSchema = z
  .strictObject({
    threadId: conversationHistoryIdSchema.nullable(),
    draft: chatTextSchema,
    aiMode: aiModeIdSchema.optional(),
    aiModeCatalogId: aiModeCatalogIdSchema.optional(),
    contextVersion: z.literal("model_window_memory_v1").optional(),
  })
  .refine(
    (value) =>
      (value.aiMode === undefined) === (value.aiModeCatalogId === undefined),
    "Mode and catalog identity must be submitted together",
  );
export type AssistantContextInput = z.infer<typeof assistantContextInputSchema>;

export const conversationMemoryPreviewSchema = z.strictObject({
  fragments: z
    .array(
      z
        .strictObject({
          messageId: conversationHistoryIdSchema,
          content: z.string().min(1).max(2000),
          start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
          sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .refine(
          (value) =>
            value.end > value.start &&
            value.end - value.start === [...value.content].length &&
            [...value.content].length <= 1000,
          "Invalid memory source range",
        ),
    )
    .max(32),
  complete: z.boolean(),
  indexComplete: z.boolean(),
  indexedMessages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

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
    memory: conversationMemoryPreviewSchema.optional(),
    contextBudget: z
      .strictObject({
        strategy: z.literal("model_window_memory_v1"),
        mode: aiModeIdSchema,
        contextWindowTokens: z.number().int().min(1).max(1_000_000),
        maxInputTokens: z.number().int().min(1).max(1_000_000),
        maxOutputTokens: z.number().int().min(1).max(128_000),
        framingReserve: z.literal(4096),
        inputTextTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        verification: z.enum(["conservative_utf8", "provider_text"]),
        needsProviderCheck: z.boolean(),
        mandatoryFits: z.boolean(),
      })
      .optional(),
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
      .max(200),
  })
  .superRefine((value, ctx) => {
    if (!value.contextBudget && value.messages.length > 18)
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Legacy context requires at most nine rounds",
      });
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
    if (
      value.threadId === null &&
      (value.messages.length > 0 ||
        value.closed ||
        (value.memory?.fragments.length ?? 0) > 0)
    )
      ctx.addIssue({
        code: "custom",
        path: ["threadId"],
        message: "No conversation was selected",
      });
  });
export type AssistantContextPreview = z.infer<
  typeof assistantContextPreviewSchema
>;

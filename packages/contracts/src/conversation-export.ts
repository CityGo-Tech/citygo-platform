import { z } from "zod";
import { agentKeySchema } from "./platform.js";
import { conversationHistoryIdSchema } from "./conversation-history.js";

export const CONVERSATION_EXPORT_MAX_MESSAGES = 5000;
export const CONVERSATION_EXPORT_MAX_BYTES = 6 * 1024 * 1024;
export const conversationExportParamsSchema = z.strictObject({
  id: conversationHistoryIdSchema,
});
export const conversationExportQuerySchema = z.strictObject({});
const text = z
  .string()
  .max(1024 * 1024)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      ),
    "Export requires valid Unicode text",
  );
export const conversationExportMessageSchema = z
  .strictObject({
    id: conversationHistoryIdSchema,
    role: z.enum(["user", "assistant"]),
    content: text,
    agentKey: agentKeySchema,
    status: z.enum(["complete", "interrupted"]),
    failureCode: z.literal("AI_CREDIT_EXHAUSTED").nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    (message) =>
      message.failureCode === null ||
      (message.role === "assistant" && message.status === "interrupted"),
  );
/** One complete server snapshot. Missing pages and silent truncation are invalid. */
export const conversationExportSchema = z
  .strictObject({
    version: z.literal(1),
    userId: conversationHistoryIdSchema,
    generatedAt: z.iso.datetime({ offset: true }),
    thread: z
      .strictObject({
        id: conversationHistoryIdSchema,
        agentKey: agentKeySchema,
        assistantKey: agentKeySchema.nullable(),
        closed: z.boolean(),
      })
      .refine(
        (thread) =>
          thread.assistantKey === null ||
          thread.assistantKey === thread.agentKey,
      ),
    messages: z
      .array(conversationExportMessageSchema)
      .max(CONVERSATION_EXPORT_MAX_MESSAGES),
  })
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.messages.every(
        (message) => conversationHistoryIdSchema.safeParse(message.id).success,
      ) &&
      snapshot.messages.some(
        (message, index) =>
          index > 0 &&
          BigInt(snapshot.messages[index - 1]!.id) >= BigInt(message.id),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Export requires unique ascending message IDs",
      });
    if (
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
      CONVERSATION_EXPORT_MAX_BYTES
    )
      ctx.addIssue({
        code: "custom",
        message: "Conversation export exceeds the aggregate byte limit",
      });
  });
export type ConversationExportSnapshot = z.infer<
  typeof conversationExportSchema
>;

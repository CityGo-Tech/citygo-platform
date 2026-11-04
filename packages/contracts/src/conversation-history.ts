import { z } from "zod";
import type { Message } from "./platform.js";
import { messageIdSchema } from "./message-favorites.js";
import { dashboardResponseSchema } from "./responses.js";

// A separate read-only page: the old detail/dashboard DTOs and AI context keep
// their existing semantics. IDs never pass through JavaScript Number.
export const conversationHistoryIdSchema = messageIdSchema.refine(
  // Legacy regex end anchors may accept a final line terminator. This new
  // boundary is canonical without broadening/changing historical DTOs.
  (value) => value === value.trim(),
);
export const conversationMessagesQuerySchema = z.strictObject({
  before: conversationHistoryIdSchema.optional(),
});
export const conversationMessageContextParamsSchema = z.strictObject({
  id: conversationHistoryIdSchema,
  messageId: conversationHistoryIdSchema,
});
export const conversationMessageContextQuerySchema = z.strictObject({});
const message = dashboardResponseSchema.shape.thread
  .unwrap()
  .shape.messages.element.safeExtend({ id: conversationHistoryIdSchema })
  .strict() satisfies z.ZodType<Message>;

export const conversationMessagesResponseSchema = z
  .strictObject({
    userId: conversationHistoryIdSchema,
    threadId: conversationHistoryIdSchema,
    messages: z.array(message).max(100),
    nextCursor: conversationHistoryIdSchema.nullable(),
  })
  .superRefine((page, ctx) => {
    // A failed Zod refinement need not abort sibling refinements. Never let
    // malformed provider/server IDs reach BigInt or escape safeParse as throws.
    if (
      page.messages.some(
        (item) => !conversationHistoryIdSchema.safeParse(item.id).success,
      )
    )
      return;
    if (
      page.messages.some(
        (item, index) =>
          index > 0 && BigInt(page.messages[index - 1]!.id) >= BigInt(item.id),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["messages"],
        message: "Messages must have unique ascending IDs",
      });
    if (
      page.nextCursor !== null &&
      (page.messages.length === 0 || page.nextCursor !== page.messages[0]?.id)
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Older messages require a nonempty page and its first ID",
      });
  });
export type ConversationMessagesPage = z.infer<
  typeof conversationMessagesResponseSchema
>;

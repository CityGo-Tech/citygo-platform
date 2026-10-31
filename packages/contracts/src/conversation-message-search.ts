import { z } from "zod";
import { agentKeySchema } from "./platform.js";
import { favoriteMessageFiltersSchema } from "./message-favorites.js";
import { conversationHistoryIdSchema } from "./conversation-history.js";

export const conversationMessageSearchQuerySchema = z.strictObject({
  search: favoriteMessageFiltersSchema.shape.search.unwrap(),
  before: conversationHistoryIdSchema.optional(),
});
export const conversationMessageSearchMatchSchema = z.strictObject({
  messageId: conversationHistoryIdSchema,
  role: z.enum(["user", "assistant"]),
  agentKey: agentKeySchema,
  status: z.enum(["complete", "interrupted"]),
  snippet: z.string().min(1).max(512),
});
export const conversationMessageSearchPageSchema = z
  .strictObject({
    userId: conversationHistoryIdSchema,
    threadId: conversationHistoryIdSchema,
    search: conversationMessageSearchQuerySchema.shape.search,
    matches: z.array(conversationMessageSearchMatchSchema).max(20),
    nextCursor: conversationHistoryIdSchema.nullable(),
  })
  .superRefine((page, ctx) => {
    if (
      page.matches.some(
        (match) =>
          !conversationHistoryIdSchema.safeParse(match.messageId).success,
      )
    )
      return;
    if (
      page.matches.some(
        (match, index) =>
          index > 0 &&
          BigInt(page.matches[index - 1]!.messageId) <= BigInt(match.messageId),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["matches"],
        message: "Search matches must have unique descending IDs",
      });
    if (
      page.nextCursor !== null &&
      (page.matches.length !== 20 ||
        page.nextCursor !== page.matches.at(-1)?.messageId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Search cursor must identify the last full-page match",
      });
  });
export type ConversationMessageSearchPage = z.infer<
  typeof conversationMessageSearchPageSchema
>;
export type ConversationMessageSearchMatch = z.infer<
  typeof conversationMessageSearchMatchSchema
>;

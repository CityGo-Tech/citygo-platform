import { z } from "zod";
import { agentKeySchema } from "./platform.js";

export const messageIdSchema = z
  .string()
  .refine(
    (value) =>
      /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  );
export const setMessageFavoriteSchema = z
  .object({ saved: z.boolean() })
  .strict();
export const messageFavoriteResultSchema = z.object({
  messageId: messageIdSchema,
  saved: z.boolean(),
});
export const favoriteMessageFiltersSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (value) =>
        !value.includes("\0") &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          value,
        ),
    )
    .optional(),
  assistantKey: agentKeySchema.optional(),
  role: z.enum(["user", "assistant"]).optional(),
});
export type FavoriteMessageFilters = z.infer<
  typeof favoriteMessageFiltersSchema
>;
export const favoriteMessagesQuerySchema = favoriteMessageFiltersSchema.extend({
  before: messageIdSchema.refine((value) => value === value.trim()).optional(),
});
export const favoriteMessageSchema = z.object({
  id: messageIdSchema,
  threadId: messageIdSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().max(1024 * 1024),
  agentKey: agentKeySchema,
  status: z.enum(["complete", "interrupted"]),
});
export const favoriteMessagesPageSchema = z.object({
  userId: messageIdSchema,
  messages: z.array(favoriteMessageSchema).max(20),
  nextBefore: messageIdSchema.nullable(),
});
export type FavoriteMessage = z.infer<typeof favoriteMessageSchema>;
export type FavoriteMessagesPage = z.infer<typeof favoriteMessagesPageSchema>;

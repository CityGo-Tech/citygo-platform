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
export const favoriteMessagesQuerySchema = z
  .object({
    before: messageIdSchema.optional(),
  })
  .strict();
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

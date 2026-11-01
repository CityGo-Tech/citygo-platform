import { z } from "zod";
import { supportRequestIdSchema } from "./human-support.js";

export const supportUpdatesQuerySchema = z.strictObject({
  before: supportRequestIdSchema.optional(),
});
export const supportUpdateSchema = z.strictObject({
  requestId: supportRequestIdSchema,
  lastReplyId: supportRequestIdSchema,
  unreadReplies: z.number().int().min(1).max(200),
});
export const supportUpdatesPageSchema = z
  .strictObject({
    userId: supportRequestIdSchema,
    unreadRequests: z.number().int().min(0).max(200),
    unreadReplies: z.number().int().min(0).max(40000),
    requests: z.array(supportUpdateSchema).max(20),
    nextBefore: supportRequestIdSchema.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      v.unreadRequests < v.requests.length ||
      v.unreadReplies < v.requests.reduce((n, r) => n + r.unreadReplies, 0) ||
      v.unreadReplies < v.unreadRequests ||
      (v.unreadRequests === 0) !== (v.unreadReplies === 0)
    )
      ctx.addIssue({ code: "custom", message: "Неверное число новых ответов" });
  });
export const markSupportRepliesReadSchema = z.strictObject({
  throughReplyId: supportRequestIdSchema,
});
export const supportReadResultSchema = z.strictObject({
  userId: supportRequestIdSchema,
  requestId: supportRequestIdSchema,
  throughReplyId: supportRequestIdSchema,
  unreadReplies: z.number().int().min(0).max(200),
});
export type SupportUpdatesQuery = z.infer<typeof supportUpdatesQuerySchema>;
export type SupportUpdatesPage = z.infer<typeof supportUpdatesPageSchema>;
export type MarkSupportRepliesRead = z.infer<
  typeof markSupportRepliesReadSchema
>;
export type SupportReadResult = z.infer<typeof supportReadResultSchema>;

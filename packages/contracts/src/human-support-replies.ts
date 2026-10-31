import { z } from "zod";
import {
  supportRequestIdSchema,
  adminSupportRequestSchema,
} from "./human-support.js";

export const supportReplyBodySchema = z
  .string()
  .trim()
  .max(8000)
  .superRefine((value, ctx) => {
    const points = Array.from(value);
    if (
      points.length < 1 ||
      points.length > 4000 ||
      value.includes("\0") ||
      points.some(
        (p) =>
          p.length === 1 &&
          p.charCodeAt(0) >= 0xd800 &&
          p.charCodeAt(0) <= 0xdfff,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Ответ должен содержать от 1 до 4000 символов",
      });
  });
export const createSupportReplySchema = z.strictObject({
  operationId: z.uuid().toLowerCase(),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  body: supportReplyBodySchema,
});
export const supportReplySchema = z.strictObject({
  id: supportRequestIdSchema,
  requestId: supportRequestIdSchema,
  operationId: z.uuid(),
  body: supportReplyBodySchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export const supportRepliesQuerySchema = z.strictObject({
  before: supportRequestIdSchema.optional(),
});
const page = {
  requestId: supportRequestIdSchema,
  replies: z.array(supportReplySchema).max(20),
  nextBefore: supportRequestIdSchema.nullable(),
};
export const supportRepliesPageSchema = z.strictObject({
  userId: supportRequestIdSchema,
  ...page,
});
export const adminSupportRepliesPageSchema = z.strictObject({
  actorId: supportRequestIdSchema,
  ...page,
});
export const supportReplyResultSchema = z.strictObject({
  actorId: supportRequestIdSchema,
  request: adminSupportRequestSchema,
  reply: supportReplySchema,
});
export type CreateSupportReply = z.infer<typeof createSupportReplySchema>;
export type SupportReply = z.infer<typeof supportReplySchema>;
export type SupportRepliesQuery = z.infer<typeof supportRepliesQuerySchema>;
export type SupportRepliesPage = z.infer<typeof supportRepliesPageSchema>;
export type AdminSupportRepliesPage = z.infer<
  typeof adminSupportRepliesPageSchema
>;
export type SupportReplyResult = z.infer<typeof supportReplyResultSchema>;

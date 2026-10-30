import { z } from "zod";
import { personalPlanIdSchema } from "./personal-plan.js";

export const supportRequestIdSchema = personalPlanIdSchema;
export const supportRequestBodyLength = (value: string) =>
  Array.from(value.trim()).length;
// PostgreSQL char_length counts Unicode code points; Zod/HTML length counts
// UTF-16 units. A raw cap of 8000 permits 4000 astral characters without ever
// accepting NUL or an unpaired surrogate that PostgreSQL cannot store exactly.
export const supportRequestBodySchema = z
  .string()
  .trim()
  .max(8000)
  .superRefine((value, ctx) => {
    const points = Array.from(value);
    if (points.length < 20 || points.length > 4000)
      ctx.addIssue({
        code: "custom",
        message: "Вопрос должен содержать от 20 до 4000 символов",
      });
    if (
      value.includes("\0") ||
      points.some(
        (point) =>
          point.length === 1 &&
          point.charCodeAt(0) >= 0xd800 &&
          point.charCodeAt(0) <= 0xdfff,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Вопрос содержит недопустимый символ",
      });
  });
export const supportRequestStatusSchema = z.enum(["open", "closed"]);
export const createSupportRequestSchema = z.strictObject({
  operationId: z.uuid().toLowerCase(),
  body: supportRequestBodySchema,
});
export const supportRequestSchema = z
  .strictObject({
    id: supportRequestIdSchema,
    operationId: z.uuid(),
    body: supportRequestBodySchema,
    status: supportRequestStatusSchema,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    closedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine((v) => (v.status === "closed") === (v.closedAt !== null));
export const supportRequestsQuerySchema = z.strictObject({
  before: supportRequestIdSchema.optional(),
  status: supportRequestStatusSchema.optional(),
});
export const supportRequestResultSchema = z.strictObject({
  userId: supportRequestIdSchema,
  request: supportRequestSchema,
});
export const supportRequestsPageSchema = z.strictObject({
  userId: supportRequestIdSchema,
  requests: z.array(supportRequestSchema).max(20),
  nextBefore: supportRequestIdSchema.nullable(),
});
export const adminSupportRequestSchema = supportRequestSchema.safeExtend({
  owner: z.strictObject({
    userId: supportRequestIdSchema,
    email: z.email().max(254).nullable(),
    username: z.string().nullable(),
  }),
});
export const adminSupportRequestResultSchema = z.strictObject({
  actorId: supportRequestIdSchema,
  request: adminSupportRequestSchema,
});
export const adminSupportRequestsPageSchema = z.strictObject({
  actorId: supportRequestIdSchema,
  requests: z.array(adminSupportRequestSchema).max(20),
  nextBefore: supportRequestIdSchema.nullable(),
});
export const updateSupportRequestStatusSchema = z.strictObject({
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: supportRequestStatusSchema,
});
export type SupportRequest = z.infer<typeof supportRequestSchema>;
export type AdminSupportRequest = z.infer<typeof adminSupportRequestSchema>;
export type CreateSupportRequest = z.infer<typeof createSupportRequestSchema>;
export type SupportRequestsQuery = z.infer<typeof supportRequestsQuerySchema>;
export type UpdateSupportRequestStatus = z.infer<
  typeof updateSupportRequestStatusSchema
>;

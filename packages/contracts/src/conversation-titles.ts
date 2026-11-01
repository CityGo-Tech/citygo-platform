import { z } from "zod";
import { conversationIdSchema } from "./platform.js";

// IDs/revisions are decimal strings. Never round PostgreSQL bigint through Number.
const revisionDecimal = /^(0|[1-9]\d{0,18})$/;
// Zod may continue refinements after a regex issue. Guard every BigInt call;
// exact match also excludes the final line break allowed by JavaScript's $.
const canonicalRevision = (value: string) =>
  revisionDecimal.exec(value)?.[0] === value;
export const conversationTitleRevisionSchema = z
  .string()
  .regex(revisionDecimal)
  .refine(
    (value) =>
      canonicalRevision(value) && BigInt(value) <= 9223372036854775807n,
  );
export const conversationCustomTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => value.length <= 80, "Не более 80 символов")
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const point = character.codePointAt(0)!;
        return (
          point > 0x1f &&
          !(point >= 0x7f && point <= 0x9f) &&
          point !== 0x2028 &&
          point !== 0x2029 &&
          !(point >= 0xd800 && point <= 0xdfff)
        );
      }),
    "Название должно занимать одну строку",
  );
export const updateConversationTitleSchema = z.strictObject({
  title: conversationCustomTitleSchema.nullable(),
  expectedRevision: conversationTitleRevisionSchema.refine(
    (value) => canonicalRevision(value) && BigInt(value) < 9223372036854775807n,
  ),
});
export const conversationTitleSchema = z
  .object({
    userId: conversationIdSchema,
    threadId: conversationIdSchema,
    title: conversationCustomTitleSchema.nullable(),
    revision: conversationTitleRevisionSchema,
    updatedAt: z.iso.datetime().nullable(),
  })
  .refine((value) =>
    value.revision === "0"
      ? value.title === null && value.updatedAt === null
      : value.updatedAt !== null,
  );
export type ConversationTitle = z.infer<typeof conversationTitleSchema>;
export type UpdateConversationTitle = z.infer<
  typeof updateConversationTitleSchema
>;

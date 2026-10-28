import { z } from "zod";
import { creditUserIdSchema } from "./ai-credit.js";

export const adminPhoneContactsQuerySchema = z.strictObject({
  afterUserId: creditUserIdSchema.optional(),
});
export const adminPhoneContactSchema = z.strictObject({
  userId: creditUserIdSchema,
  email: z.email().max(254),
  username: z.string().min(1).max(64).nullable(),
  phone: z.string().regex(/^\+79[0-9]{9}$/),
  verifiedAt: z.iso.datetime(),
});
export const adminPhoneContactsResponseSchema = z
  .strictObject({
    contacts: z.array(adminPhoneContactSchema).max(50),
    nextAfterUserId: creditUserIdSchema.nullable(),
  })
  .refine(
    ({ contacts, nextAfterUserId }) =>
      contacts.every(
        (contact, i) =>
          i === 0 || BigInt(contact.userId) > BigInt(contacts[i - 1]!.userId),
      ) &&
      (nextAfterUserId === null ||
        (contacts.length === 50 &&
          nextAfterUserId === contacts.at(-1)?.userId)),
    "Страница клиентской базы не соответствует курсору",
  );
export type AdminPhoneContactsQuery = z.infer<
  typeof adminPhoneContactsQuerySchema
>;
export type AdminPhoneContactsPage = z.infer<
  typeof adminPhoneContactsResponseSchema
>;

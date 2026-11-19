import { z } from "zod";

export const messengerProviderSchema = z.enum(["telegram", "max"]);
export type MessengerProvider = z.infer<typeof messengerProviderSchema>;

const messengerLaunchPurposeSchema = z.enum([
  "guest",
  "housing",
  "coordinator",
]);
const messengerAccountSchema = z.strictObject({
  id: z.string().regex(/^[1-9][0-9]*$/),
  email: z.email().max(254),
});

export const miniAppSignInResponseSchema = z.strictObject({
  user: messengerAccountSchema,
  purpose: messengerLaunchPurposeSchema,
});
export const prepareMessengerLinkResponseSchema = messengerAccountSchema.extend(
  {
    confirmation: z.string().regex(/^[0-9a-f]{64}$/),
  },
);
export const linkMessengerResponseSchema = z.strictObject({
  linked: z.literal(true),
});
export const messengerLinksResponseSchema = z.strictObject({
  providers: z.array(messengerProviderSchema).max(2),
});

import { z } from "zod";

// These contracts describe test checkout only. A redirect or client report is
// never payment evidence; the server must reconcile with the provider.
export const createTopupSchema = z.strictObject({
  requestId: z.uuid(),
  amountKopeks: z.number().int().min(100).max(1_000_000),
});
export type CreateTopupInput = z.infer<typeof createTopupSchema>;

export const topupOrderSchema = z
  .strictObject({
    orderId: z.uuid(),
    amountKopeks: createTopupSchema.shape.amountKopeks,
    creditMicros: z.number().int().min(1_000_000).max(10_000_000_000),
    currency: z.literal("RUB"),
    test: z.literal(true),
    status: z.enum([
      "creating",
      "pending",
      "succeeded",
      "canceled",
      "review_required",
    ]),
    credited: z.boolean(),
    confirmationUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        } catch {
          return false;
        }
      })
      .optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine((order) => order.creditMicros === order.amountKopeks * 10_000)
  .refine((order) => !order.credited || order.status === "succeeded")
  .refine(
    (order) => Date.parse(order.createdAt) <= Date.parse(order.updatedAt),
  );
export type TopupOrder = z.infer<typeof topupOrderSchema>;

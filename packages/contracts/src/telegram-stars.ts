import { z } from "zod";

export const TELEGRAM_STARS_TEST_PRICE = 1;

export const telegramStarsOrderSchema = z.strictObject({
  id: z.uuid(),
  currency: z.literal("XTR"),
  amount: z.literal(TELEGRAM_STARS_TEST_PRICE),
  status: z.enum(["pending", "checkout", "paid", "cancelled", "refunded"]),
  createdAt: z.iso.datetime(),
});

export const telegramStarsSnapshotSchema = z.strictObject({
  currency: z.literal("XTR"),
  testPrice: z.literal(TELEGRAM_STARS_TEST_PRICE),
  balance: z.number().int().nonnegative(),
  orders: z.array(telegramStarsOrderSchema),
});

export const createTelegramStarsOrderInputSchema = z.strictObject({
  requestId: z.uuid(),
});

export const telegramStarsOrderResponseSchema = z.strictObject({
  order: telegramStarsOrderSchema,
});

export const createdTelegramStarsOrderSchema = telegramStarsOrderResponseSchema
  .extend({ invoiceUrl: z.string() })
  .refine(
    ({ order, invoiceUrl }) =>
      invoiceUrl === `https://t.me/$citygo-test-${order.id}`,
  );

export type TelegramStarsOrder = z.infer<typeof telegramStarsOrderSchema>;
export type TelegramStarsSnapshot = z.infer<typeof telegramStarsSnapshotSchema>;

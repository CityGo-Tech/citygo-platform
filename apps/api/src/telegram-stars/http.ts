import { createHash, timingSafeEqual } from "node:crypto";
import { createTelegramStarsOrderInputSchema } from "@citygo/contracts";
import { DomainError } from "@citygo/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createTelegramStarsTestStore,
  type RefundStarPayment,
  type TelegramStarsActor,
} from "./store.js";

export const TELEGRAM_STARS_TEST_WEBHOOK_PATH =
  "/v1/telegram/stars-test/webhook";
const starsPath = "/v1/mini-apps/telegram/stars";
const orderParams = z.object({ id: z.uuid() });
const noCommandInput = z.strictObject({}).optional();
const webhookToken = /^[a-zA-Z0-9_-]{1,256}$/;
const tokenDigest = (token: string) =>
  createHash("sha256").update(token).digest();
const userId = z
  .int()
  .positive()
  .max(2 ** 52 - 1);
const telegramUser = z.object({ id: userId, is_bot: z.boolean().optional() });
const telegramReference = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x20\x7f]+$/);
// Telegram can attach order and user metadata. Parse only fields used for
// verification; names, contact details and provider metadata are discarded.
const invoice = z.object({
  invoice_payload: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 128),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total_amount: z.int().positive(),
});
const payment = invoice.extend({
  telegram_payment_charge_id: telegramReference,
});
const telegramUpdate = z
  .object({
    update_id: z.int().nonnegative(),
    pre_checkout_query: invoice
      .extend({ id: telegramReference, from: telegramUser })
      .optional(),
    message: z
      .object({
        from: telegramUser.optional(),
        chat: z.object({
          id: z.int().max(2 ** 52 - 1),
          type: z.string().max(32),
        }),
        text: z.string().max(4096).optional(),
        successful_payment: payment.optional(),
        refunded_payment: payment.optional(),
      })
      .optional(),
  })
  .refine(
    ({ pre_checkout_query, message }) =>
      !(pre_checkout_query && message) &&
      !(message?.successful_payment && message?.refunded_payment),
  );
const paySupportCommand =
  /^\/paysupport(?:@[a-zA-Z0-9_]{5,32})?(?:[ \t]+[^\r\n]*)?$/;
const paySupportText =
  "По тестовому заказу откройте CityGo → Профиль → Помощь человека. Укажите номер заказа CityGo.";

export function registerTelegramStarsTest(
  app: FastifyInstance,
  options: {
    actor: (request: FastifyRequest) => Promise<TelegramStarsActor>;
    webhookSecret: string;
    refundStarPayment: RefundStarPayment;
  },
) {
  if (!webhookToken.test(options.webhookSecret))
    throw new Error("Invalid Telegram Stars test webhook secret");
  const expectedToken = tokenDigest(options.webhookSecret);
  const store = createTelegramStarsTestStore(options.refundStarPayment);
  const command = {
    bodyLimit: 1024,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  };

  app.get(starsPath, async (request) =>
    store.snapshot(await options.actor(request)),
  );
  app.post(starsPath + "/orders", command, async (request) => {
    const actor = await options.actor(request);
    const { requestId } = createTelegramStarsOrderInputSchema.parse(
      request.body,
    );
    const order = store.create(actor, requestId.toLowerCase());
    const invoiceUrl = `https://t.me/$citygo-test-${order.id}`;
    return { order, invoiceUrl };
  });
  app.post(starsPath + "/orders/:id/cancel", command, async (request) => {
    const actor = await options.actor(request);
    noCommandInput.parse(request.body);
    const { id } = orderParams.parse(request.params);
    return { order: store.cancel(actor, id.toLowerCase()) };
  });
  app.post(starsPath + "/orders/:id/refund", command, async (request) => {
    const actor = await options.actor(request);
    noCommandInput.parse(request.body);
    const { id } = orderParams.parse(request.params);
    return { order: await store.refund(actor, id.toLowerCase()) };
  });

  app.post(
    TELEGRAM_STARS_TEST_WEBHOOK_PATH,
    {
      bodyLimit: 16_384,
      onRequest: async (request) => {
        const headers = request.headers;
        const token = headers["x-telegram-bot-api-secret-token"];
        if (
          headers.origin !== undefined ||
          headers.cookie !== undefined ||
          headers.authorization !== undefined ||
          request.url.includes("?") ||
          typeof token !== "string" ||
          !webhookToken.test(token) ||
          !timingSafeEqual(expectedToken, tokenDigest(token))
        )
          throw new DomainError(403, "Не удалось подтвердить вебхук Telegram.");
      },
    },
    async (request) => {
      const update = telegramUpdate.parse(request.body);
      const checkout = update.pre_checkout_query;
      if (checkout) {
        const ok =
          !checkout.from.is_bot &&
          store.approve(checkout.from.id, checkout.id, checkout);
        return {
          method: "answerPreCheckoutQuery",
          pre_checkout_query_id: checkout.id,
          ok,
          ...(ok
            ? {}
            : { error_message: "Этот тестовый заказ недоступен для оплаты." }),
        };
      }
      const message = update.message;
      if (!message) return { ok: true };
      const payment = message.successful_payment ?? message.refunded_payment;
      const privateChat =
        message.chat.type === "private" && message.chat.id > 0;
      const fromBuyer =
        message.from?.id === message.chat.id && !message.from.is_bot;
      if (payment) {
        if (!privateChat || (message.successful_payment && !fromBuyer))
          throw new DomainError(
            409,
            "Платёж не соответствует тестовому заказу.",
          );
        store.applyPayment(
          message.chat.id,
          payment,
          !!message.refunded_payment,
        );
      } else if (
        privateChat &&
        fromBuyer &&
        message.text &&
        paySupportCommand.test(message.text)
      ) {
        return {
          method: "sendMessage",
          chat_id: message.chat.id,
          text: paySupportText,
        };
      }
      return { ok: true };
    },
  );
}

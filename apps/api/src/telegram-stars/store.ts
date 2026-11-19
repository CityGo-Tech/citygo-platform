import { randomUUID } from "node:crypto";
import {
  TELEGRAM_STARS_TEST_PRICE,
  type TelegramStarsOrder,
} from "@citygo/contracts";
import { DomainError } from "@citygo/db";

export type TelegramStarsActor = {
  userId: string;
  telegramUserId: string;
};

export type RefundStarPayment = (input: {
  user_id: number;
  telegram_payment_charge_id: string;
}) => Promise<boolean>;

type TestOrder = {
  actor: TelegramStarsActor;
  order: TelegramStarsOrder;
  checkoutId?: string;
  chargeId?: string;
  refundTask?: Promise<void>;
};

type Invoice = {
  invoice_payload: string;
  currency: string;
  total_amount: number;
};
type Payment = Invoice & { telegram_payment_charge_id: string };

const sameActor = (first: TelegramStarsActor, second: TelegramStarsActor) =>
  first.userId === second.userId &&
  first.telegramUserId === second.telegramUserId;

export function createTelegramStarsTestStore(
  refundStarPayment: RefundStarPayment,
) {
  // Retain evidence for this isolated API instance so stale retries cannot
  // recreate an invoice after the user has left the Mini App.
  const orders = new Map<string, TestOrder>();
  const requests = new Map<string, TestOrder>();
  const checkouts = new Set<string>();
  const charges = new Map<string, TestOrder>();
  const maxOrders = 2000;
  const maxOrdersPerActor = 100;

  function ownOrders(actor: TelegramStarsActor) {
    return [...orders.values()].filter((entry) =>
      sameActor(actor, entry.actor),
    );
  }
  function owned(actor: TelegramStarsActor, id: string) {
    const entry = orders.get(id);
    if (!entry || !sameActor(actor, entry.actor))
      throw new DomainError(404, "Тестовый заказ не найден.");
    return entry;
  }
  function forInvoice(telegramUserId: number, invoice: Invoice) {
    const entry = orders.get(invoice.invoice_payload);
    return entry?.actor.telegramUserId === String(telegramUserId) &&
      invoice.currency === "XTR" &&
      invoice.total_amount === TELEGRAM_STARS_TEST_PRICE
      ? entry
      : undefined;
  }
  function applyPayment(
    telegramUserId: number,
    payment: Payment,
    refunded: boolean,
  ) {
    const entry = forInvoice(telegramUserId, payment);
    const chargeId = payment.telegram_payment_charge_id;
    if (
      !entry ||
      !entry.checkoutId ||
      (entry.chargeId && entry.chargeId !== chargeId) ||
      (charges.has(chargeId) && charges.get(chargeId) !== entry)
    )
      throw new DomainError(409, "Платёж не соответствует тестовому заказу.");

    entry.chargeId = chargeId;
    charges.set(chargeId, entry);
    // Telegram may deliver the refund before the success message. A terminal
    // refund always wins. A late success with this charge cannot reissue value.
    if (refunded) {
      entry.order.status = "refunded";
      return false;
    }
    if (entry.order.status !== "checkout") return false;
    entry.order.status = "paid";
    return true;
  }

  return {
    snapshot(actor: TelegramStarsActor) {
      const own = ownOrders(actor)
        .reverse()
        .map(({ order }) => ({ ...order }));
      return {
        currency: "XTR" as const,
        testPrice: TELEGRAM_STARS_TEST_PRICE,
        balance: own.filter(({ status }) => status === "paid").length,
        orders: own,
      };
    },
    create(actor: TelegramStarsActor, requestId: string) {
      const key = JSON.stringify([
        actor.userId,
        actor.telegramUserId,
        requestId,
      ]);
      const previous = requests.get(key);
      if (previous) return { ...previous.order };
      if (
        orders.size >= maxOrders ||
        ownOrders(actor).length >= maxOrdersPerActor
      )
        throw new DomainError(429, "Достигнут лимит тестовых заказов.");
      const id = randomUUID();
      const entry: TestOrder = {
        actor,
        order: {
          id,
          currency: "XTR",
          amount: TELEGRAM_STARS_TEST_PRICE,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      };
      orders.set(id, entry);
      requests.set(key, entry);
      return { ...entry.order };
    },
    cancel(actor: TelegramStarsActor, id: string) {
      const entry = owned(actor, id);
      if (entry.order.status === "pending") entry.order.status = "cancelled";
      else if (entry.order.status !== "cancelled")
        throw new DomainError(409, "Этот тестовый заказ уже нельзя отменить.");
      return { ...entry.order };
    },
    approve(telegramUserId: number, checkoutId: string, invoice: Invoice) {
      const entry = forInvoice(telegramUserId, invoice);
      if (!entry) return false;
      if (entry.checkoutId === checkoutId) return true;
      if (entry.order.status !== "pending" || checkouts.has(checkoutId))
        return false;
      checkouts.add(checkoutId);
      entry.checkoutId = checkoutId;
      entry.order.status = "checkout";
      return true;
    },
    applyPayment,
    async refund(actor: TelegramStarsActor, id: string) {
      const entry = owned(actor, id);
      if (entry.order.status === "refunded") return { ...entry.order };
      const chargeId = entry.chargeId;
      if (entry.order.status !== "paid" || !chargeId)
        throw new DomainError(409, "Для возврата нужна подтверждённая оплата.");

      // Publish the in-flight promise before calling the adapter so that
      // concurrent requests for this order share one refund attempt.
      const task = (entry.refundTask ??= Promise.resolve().then(async () => {
        if (entry.order.status === "refunded") return;
        const refunded = await refundStarPayment({
          user_id: Number(entry.actor.telegramUserId),
          telegram_payment_charge_id: chargeId,
        });
        if (refunded !== true) throw new Error("Simulated refund rejected");
        entry.order.status = "refunded";
      }));
      try {
        await task;
      } catch {
        // A trusted webhook can confirm a refund while a response is lost.
        if (entry.order.status === "paid")
          throw new DomainError(
            502,
            "Возврат не подтверждён. Проверьте статус заказа.",
          );
      } finally {
        if (entry.refundTask === task) delete entry.refundTask;
      }
      return { ...entry.order };
    },
  };
}

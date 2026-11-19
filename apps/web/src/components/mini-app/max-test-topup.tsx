"use client";

import { createClient } from "@citygo/api-client";
import {
  createTopupSchema,
  maxTopupOrderSchema,
  yooKassaReceiptEmailSchema,
  type CreateTopupInput,
  type MaxTopupOrder,
  type OwnerPaymentRefund,
} from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import { useEffect, useRef, useState } from "react";
import { receiptMoney } from "../owner-receipts-state";
import { paymentAmountKopeks, topupStatusLabels } from "../payment-attempt";
import styles from "./max-test-topup.module.css";

const receiptLabels = {
  pending: "Регистрация чека ожидается",
  succeeded: "Чек зарегистрирован в тестовом контуре",
  canceled: "Регистрация чека отменена",
};

const refundLabels: Record<OwnerPaymentRefund["status"], string> = {
  reserved: "Запрос возврата сохранён",
  unknown: "Статус возврата уточняется",
  pending: "Возврат обрабатывается",
  succeeded: "Возврат подтверждён",
  canceled: "Возврат отменён",
  review_required: "Возврат требует проверки",
};

type View = {
  orders: MaxTopupOrder[];
  refunds: OwnerPaymentRefund[] | null;
  refundError: boolean;
  busy: boolean;
  unknownAttempt: boolean;
  error: string;
};

function initialView(orders: MaxTopupOrder[]): View {
  return {
    orders,
    refunds: null,
    refundError: false,
    busy: false,
    unknownAttempt: false,
    error: "",
  };
}

function checkoutUrl(order: MaxTopupOrder): string | undefined {
  const parsed = maxTopupOrderSchema.safeParse(order);
  if (
    !parsed.success ||
    !parsed.data.test ||
    parsed.data.status !== "pending" ||
    !parsed.data.confirmationUrl
  )
    return;
  const url = new URL(parsed.data.confirmationUrl);
  if (url.origin === "https://yoomoney.ru") return url.href;
}

function maxTopupResource({
  orders,
  client,
  signal,
  onChange,
  openPayment,
  onAttemptConfirmed,
  onBalanceChanged,
}: {
  orders: MaxTopupOrder[];
  client: ReturnType<typeof createClient>;
  signal: AbortSignal;
  onChange: (view: View) => void;
  openPayment: (url: string) => void;
  onAttemptConfirmed: () => void;
  onBalanceChanged: () => void;
}) {
  let view = initialView(orders);
  let attempt: CreateTopupInput | undefined;
  let launchedOrder: string | undefined;

  function publish(patch: Partial<View>) {
    if (signal.aborted) return;
    view = { ...view, ...patch };
    onChange(view);
  }

  function save(order: MaxTopupOrder, expectedId?: string) {
    if (!order.test || (expectedId && order.orderId !== expectedId))
      throw new Error("Unexpected test payment response");
    const exists = view.orders.some((item) => item.orderId === order.orderId);
    publish({
      orders: exists
        ? view.orders.map((item) =>
            item.orderId === order.orderId ? order : item,
          )
        : [order, ...view.orders],
    });
  }

  async function readRefunds() {
    try {
      const { refunds } = await client.paymentRefunds();
      publish({
        refunds: refunds.filter((refund) => refund.test),
        refundError: false,
      });
    } catch {
      publish({ refundError: true });
    }
  }

  async function work(action: () => Promise<void>, error: string) {
    if (signal.aborted || view.busy) return;
    publish({ busy: true, error: "" });
    try {
      await action();
    } catch {
      publish({ error });
    } finally {
      publish({ busy: false });
    }
  }

  function acceptAttempt(order: MaxTopupOrder) {
    if (!attempt || attempt.amountKopeks !== order.amountKopeks)
      throw new Error("Unexpected payment attempt");
    save(order);
    attempt = undefined;
    publish({ unknownAttempt: false });
    if (!signal.aborted) onAttemptConfirmed();
  }

  async function create(amountKopeks: number, receiptEmail: string) {
    await work(async () => {
      attempt ??= createTopupSchema.parse({
        requestId: crypto.randomUUID(),
        amountKopeks,
        receiptEmail,
      });
      publish({ unknownAttempt: true });
      acceptAttempt(await client.createMaxTopup(attempt));
    }, "Создание платежа не подтверждено. Проверьте платёж или повторите попытку.");
  }

  async function recover() {
    await work(async () => {
      if (attempt)
        acceptAttempt(await client.maxTopupAttempt(attempt.requestId));
    }, "Платёж не найден. Можно повторить создание с той же суммой.");
  }

  async function check(id?: string) {
    await work(async () => {
      try {
        if (id) {
          const order = await client.reconcileMaxTopup(id);
          save(order, id);
          if (order.credited && !signal.aborted) onBalanceChanged();
        }
      } finally {
        await readRefunds();
      }
    }, "Не удалось проверить платёж. Попробуйте ещё раз.");
  }

  function open(id: string) {
    if (signal.aborted || view.busy) return;
    const order = view.orders.find((item) => item.orderId === id);
    const url = order && checkoutUrl(order);
    if (!url) return;
    launchedOrder = id;
    try {
      openPayment(url);
    } catch {
      launchedOrder = undefined;
      publish({ error: "Не удалось открыть тестовую оплату в MAX." });
    }
  }

  function afterReturn() {
    if (!launchedOrder || document.hidden || view.busy || signal.aborted)
      return;
    const id = launchedOrder;
    launchedOrder = undefined;
    void check(id);
  }

  return { create, recover, check, open, afterReturn };
}

export function MaxTestTopupPanel({
  initialOrders,
  sessionSignal,
  openPayment,
  onAccessDenied,
  onBalanceChanged,
}: {
  initialOrders: MaxTopupOrder[];
  sessionSignal: AbortSignal;
  openPayment: (url: string) => void;
  onAccessDenied: () => void;
  onBalanceChanged: () => void;
}) {
  const [model, setModel] = useState<{
    session: AbortSignal;
    view: View;
  } | null>(null);
  const [amount, setAmount] = useState("100");
  const [receiptEmail, setReceiptEmail] = useState("");
  const callbacks = useRef({ onAccessDenied, onBalanceChanged });
  const heading = useRef<HTMLHeadingElement>(null);
  const resource = useRef<ReturnType<typeof maxTopupResource> | null>(null);
  useEffect(() => {
    callbacks.current = { onAccessDenied, onBalanceChanged };
  }, [onAccessDenied, onBalanceChanged]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = maxTopupResource({
      orders: initialOrders,
      signal,
      client: createClient("/api", {
        signal: () => signal,
        onUnauthorized: () => {
          if (!signal.aborted) callbacks.current.onAccessDenied();
        },
      }),
      openPayment,
      onChange: (view) => setModel({ session: sessionSignal, view }),
      onAttemptConfirmed: () => setReceiptEmail(""),
      onBalanceChanged: () => callbacks.current.onBalanceChanged(),
    });
    resource.current = current;
    window.addEventListener("focus", current.afterReturn);
    document.addEventListener("visibilitychange", current.afterReturn);
    heading.current?.focus();
    const latest =
      initialOrders.find((order) =>
        ["creating", "pending"].includes(order.status),
      ) ?? initialOrders.find((order) => order.status === "succeeded");
    void current.check(latest?.orderId);
    return () => {
      controller.abort();
      window.removeEventListener("focus", current.afterReturn);
      document.removeEventListener("visibilitychange", current.afterReturn);
      if (resource.current === current) resource.current = null;
    };
  }, [initialOrders, openPayment, sessionSignal]);
  if (sessionSignal.aborted) return null;
  const view =
    model?.session === sessionSignal ? model.view : initialView(initialOrders);
  const amountKopeks = paymentAmountKopeks(amount);
  const email = yooKassaReceiptEmailSchema.safeParse(receiptEmail.trim());
  const unsettled = view.orders.some((order) =>
    ["creating", "pending", "review_required"].includes(order.status),
  );
  return (
    <Card
      className={`${styles.panel} ym-hide-content ym-disable-keys`}
      data-citygo-private
      data-citygo-analytics-private
      aria-labelledby="max-test-topup-heading"
    >
      <h2 id="max-test-topup-heading" ref={heading} tabIndex={-1}>
        Тестовое пополнение
      </h2>
      <p>Тестовая оплата. Деньги не списываются.</p>
      {!unsettled && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (amountKopeks !== null && email.success)
              void resource.current?.create(amountKopeks, email.data);
          }}
        >
          <Field
            label="Сумма пополнения"
            hint="От 1 до 10 000 ₽"
            inputMode="decimal"
            value={amount}
            disabled={view.busy || view.unknownAttempt}
            onChange={(event) => setAmount(event.target.value)}
          />
          <Field
            label="Email для чека"
            hint="Укажите тестовый email."
            type="email"
            inputMode="email"
            autoComplete="off"
            value={receiptEmail}
            maxLength={254}
            disabled={view.busy || view.unknownAttempt}
            onChange={(event) => setReceiptEmail(event.target.value)}
          />
          <Button
            type="submit"
            disabled={view.busy || amountKopeks === null || !email.success}
          >
            {view.unknownAttempt
              ? "Повторить создание платежа"
              : "Создать тестовый платёж"}
          </Button>
          {view.unknownAttempt && (
            <Button
              type="button"
              variant="secondary"
              disabled={view.busy}
              onClick={() => void resource.current?.recover()}
            >
              Найти платёж
            </Button>
          )}
        </form>
      )}
      {view.busy && <p role="status">Проверяем платёж…</p>}
      {view.error && <p role="alert">{view.error}</p>}
      {view.orders.length > 0 && (
        <ul className={styles.list} aria-label="Тестовые платежи">
          {view.orders.map((order) => (
            <li key={order.orderId}>
              <p>
                <strong>{receiptMoney(order.amountKopeks)}</strong> ·{" "}
                {topupStatusLabels[order.status]}
              </p>
              <p>
                {order.credited
                  ? "Зачисление подтверждено"
                  : "Зачисление не подтверждено"}
              </p>
              <p>
                {order.receiptRegistration
                  ? receiptLabels[order.receiptRegistration]
                  : "Чек ещё не подтверждён"}
              </p>
              <details>
                <summary>Данные для поддержки</summary>
                <p>Номер платежа: {order.orderId}</p>
              </details>
              {checkoutUrl(order) && (
                <Button
                  type="button"
                  disabled={view.busy}
                  onClick={() => resource.current?.open(order.orderId)}
                >
                  Перейти к оплате
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={view.busy}
                onClick={() => void resource.current?.check(order.orderId)}
              >
                Проверить платёж
              </Button>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="max-test-refunds-heading">
        <h3 id="max-test-refunds-heading">Тестовые возвраты</h3>
        {view.refundError && <p role="alert">Не удалось загрузить возвраты.</p>}
        {view.refunds &&
          (view.refunds.length > 0 ? (
            <ul className={styles.list}>
              {view.refunds.map((refund) => (
                <li key={refund.id}>
                  {refundLabels[refund.status]} ·{" "}
                  {receiptMoney(refund.amountKopeks)}
                </li>
              ))}
            </ul>
          ) : (
            <p>Возвратов пока нет.</p>
          ))}
      </section>
    </Card>
  );
}

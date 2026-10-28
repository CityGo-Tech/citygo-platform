"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createTopupSchema,
  formatMoneyMicros,
  yooKassaReceiptEmailSchema,
  type CreateTopupInput,
  type TopupOrder,
} from "@citygo/contracts";
import { Button, Field } from "@citygo/ui-web";
import {
  parsePaymentAttempt,
  paymentAmountKopeks,
  type PaymentAttempt,
} from "./payment-attempt";
import { openPaymentPopup, type PaymentPopup } from "./payment-popup";
import { trackProductEvent } from "./product-analytics";

export type TopupActions = {
  createTopup: (input: CreateTopupInput) => Promise<TopupOrder>;
  topupOrder: (orderId: string) => Promise<TopupOrder>;
  topupAttempt: (requestId: string) => Promise<TopupOrder>;
  reconcileTopup: (orderId: string) => Promise<TopupOrder>;
  onCredited: () => Promise<void>;
};

const statusLabels: Record<TopupOrder["status"], string> = {
  creating: "Платёж создаётся…",
  pending: "Ожидаем оплату.",
  succeeded: "Оплата подтверждена.",
  canceled: "Платёж отменён.",
  review_required: "Нужна проверка платежа. Не оплачивайте повторно.",
};

/** Explicit server-selected mode, never a return-URL settlement handler. */
export function TestTopupPanel({
  userId,
  actions,
  disabled,
  canCreate,
}: {
  userId: string;
  actions: TopupActions;
  disabled: boolean;
  canCreate: boolean;
}) {
  const [amount, setAmount] = useState("100");
  const [receiptEmail, setReceiptEmail] = useState("");
  const [attempt, setAttempt] = useState<PaymentAttempt | null>(null);
  const [order, setOrder] = useState<TopupOrder | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [popupNotice, setPopupNotice] = useState("");
  const inFlight = useRef(false);
  const pendingPopup = useRef<PaymentPopup | null>(null);
  // Buyer contact is frozen for this request only, and never persisted in the
  // browser. A restored ambiguous attempt must not adopt a different email.
  const frozenCreate = useRef<CreateTopupInput | null>(null);
  const revision = useRef(0);
  const key = `citygo.test-topup.${userId}`;
  useEffect(() => {
    let active = true;
    const loadedRevision = revision.current;
    try {
      const saved = parsePaymentAttempt(sessionStorage.getItem(key));
      // Only non-sensitive identity and amount are restored after a reload.
      sessionStorage.setItem(`${key}.probe`, "1");
      sessionStorage.removeItem(`${key}.probe`);
      setAttempt(saved);
      setReady(true);
      if (saved) setAmount(String(saved.amountKopeks / 100));
      if (saved) {
        void (
          saved.orderId
            ? actions.topupOrder(saved.orderId)
            : actions.topupAttempt(saved.requestId)
        )
          .then((value) => {
            if (!active || loadedRevision !== revision.current) return;
            if (value.amountKopeks !== saved.amountKopeks)
              throw new Error("Payment attempt mismatch");
            const recovered = { ...saved, orderId: value.orderId };
            sessionStorage.setItem(key, JSON.stringify(recovered));
            setAttempt(recovered);
            setOrder(value);
          })
          .catch(() => {
            if (active && loadedRevision === revision.current)
              setError(
                "Не удалось загрузить платёж. Попробуйте проверить его ещё раз.",
              );
          });
      }
    } catch {
      setError(
        "Не удалось восстановить платёж. Не оплачивайте повторно — обратитесь в поддержку.",
      );
    }
    return () => {
      active = false;
      pendingPopup.current?.close();
      pendingPopup.current = null;
    };
    // Actions use the current session guard; remount when the account changes.
  }, [key]);

  async function work(action: () => Promise<void>) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    revision.current++;
    setPending(true);
    setError("");
    try {
      await action();
    } catch {
      setError(
        "Не удалось проверить платёж. Попробуйте ещё раз. Если деньги уже списаны, не оплачивайте повторно.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    const amountKopeks = paymentAmountKopeks(amount);
    if (
      !canCreate ||
      disabled ||
      inFlight.current ||
      !ready ||
      amountKopeks === null ||
      attempt?.orderId ||
      (attempt && !frozenCreate.current)
    )
      return;
    const parsed = createTopupSchema.safeParse(
      frozenCreate.current ?? {
        requestId: crypto.randomUUID(),
        amountKopeks,
        receiptEmail: receiptEmail.trim(),
      },
    );
    if (!parsed.success) {
      setError("Укажите email для чека.");
      return;
    }
    // Keep the browser's user activation: allocate the safe blank tab before
    // work() or a network call can await. Recovery/read-only paths never do this.
    const popup = openPaymentPopup();
    pendingPopup.current = popup;
    setPopupNotice(
      popup.opened
        ? "Открываем страницу оплаты…"
        : "Не удалось открыть вкладку. Нажмите «Перейти к оплате» ниже.",
    );
    void work(async () => {
      try {
        const input = frozenCreate.current ?? parsed.data;
        const next = attempt ?? {
          requestId: input.requestId,
          amountKopeks: input.amountKopeks,
        };
        // Persist before the network call, including requests with an unknown result.
        sessionStorage.setItem(key, JSON.stringify(next));
        frozenCreate.current = input;
        setAttempt(next);
        const value = await actions.createTopup(input);
        if (!value.test)
          trackProductEvent(
            "payment_created",
            { surface: "wallet" },
            value.orderId,
          );
        const saved = { ...next, orderId: value.orderId };
        setOrder(value);
        setAttempt(saved);
        sessionStorage.setItem(key, JSON.stringify(saved));
        const opened = popup.navigate(value);
        if (!value.test && opened)
          trackProductEvent(
            "payment_redirected",
            { surface: "wallet" },
            value.orderId,
          );
        setPopupNotice(
          value.status === "pending" && value.confirmationUrl
            ? opened
              ? "Оплата открыта в новой вкладке."
              : "Нажмите «Перейти к оплате», чтобы продолжить."
            : "Проверьте статус платежа.",
        );
        if (value.credited) {
          if (!value.test)
            trackProductEvent(
              "payment_credited",
              { surface: "wallet" },
              value.orderId,
            );
          await actions.onCredited();
        }
      } catch (error) {
        popup.close();
        setPopupNotice("");
        throw error;
      } finally {
        if (pendingPopup.current === popup) pendingPopup.current = null;
      }
    });
  }

  function check() {
    if (!attempt) return;
    void work(async () => {
      const value = attempt.orderId
        ? await actions.reconcileTopup(attempt.orderId)
        : await actions.topupAttempt(attempt.requestId);
      if (value.amountKopeks !== attempt.amountKopeks)
        throw new Error("Payment attempt mismatch");
      if (!value.test) {
        if (value.credited && !order?.credited)
          trackProductEvent(
            "payment_credited",
            { surface: "wallet" },
            value.orderId,
          );
        if (value.status === "canceled" && order?.status !== "canceled")
          trackProductEvent(
            "payment_canceled",
            { surface: "wallet" },
            value.orderId,
          );
        if (
          value.status === "review_required" &&
          order?.status !== value.status
        )
          trackProductEvent(
            "payment_review_required",
            { surface: "wallet" },
            value.orderId,
          );
      }
      const saved = { ...attempt, orderId: value.orderId };
      sessionStorage.setItem(key, JSON.stringify(saved));
      setAttempt(saved);
      setOrder(value);
      if (value.credited) await actions.onCredited();
    });
  }
  const locked = disabled || pending;
  const terminal =
    order?.status === "canceled" ||
    (order?.status === "succeeded" && order.credited);
  // Admission closes only new external payment creation, not recovery of an
  // existing order. Keep the saved identity and server verification available.
  if (!canCreate && !attempt) return error ? <p role="alert">{error}</p> : null;
  return (
    <section
      className="citygo-topup ym-hide-content"
      aria-label="Пополнение баланса"
    >
      <h3>Пополнение баланса</h3>
      {!canCreate && (
        <p role="status">
          Пополнение временно недоступно. Ранее созданный платёж можно
          проверить.
        </p>
      )}
      {canCreate && (
        <form onSubmit={create}>
          <Field
            className="ym-disable-keys"
            label="Сумма пополнения"
            hint="От 1 до 10 000 ₽"
            inputMode="decimal"
            value={amount}
            disabled={locked || !!attempt}
            onChange={(event) => setAmount(event.target.value)}
          />
          {!attempt && (
            <Field
              className="ym-disable-keys"
              label="Email для чека"
              hint="На этот адрес придёт чек."
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              maxLength={254}
              value={receiptEmail}
              disabled={locked}
              onChange={(event) => setReceiptEmail(event.target.value)}
            />
          )}
          {!attempt?.orderId && (!attempt || frozenCreate.current) && (
            <Button
              className="ym-show-content"
              type="submit"
              disabled={
                locked ||
                !ready ||
                paymentAmountKopeks(amount) === null ||
                (!attempt &&
                  !yooKassaReceiptEmailSchema.safeParse(receiptEmail.trim())
                    .success)
              }
            >
              {attempt ? "Продолжить оплату" : "Пополнить баланс"}
            </Button>
          )}
        </form>
      )}
      {popupNotice && <p role="status">{popupNotice}</p>}
      {attempt && !attempt.orderId && !frozenCreate.current && (
        <p>
          Платёж пока не подтверждён. Не оплачивайте повторно. Если статус не
          обновляется, обратитесь в поддержку.
        </p>
      )}
      {order && (
        <div role="status">
          {order.test && <p>Тестовая оплата. Деньги не списываются.</p>}
          <p>{statusLabels[order.status]}</p>
          <p>
            {formatMoneyMicros(order.creditMicros)} ₽ CityGo ·{" "}
            {order.credited
              ? "зачислено на баланс"
              : "зачисление не подтверждено"}
          </p>
        </div>
      )}
      {order?.confirmationUrl && order.status === "pending" && (
        <div>
          {!canCreate && (
            <p>Если деньги уже списаны, сначала проверьте платёж.</p>
          )}
          <p>
            <a
              className="cg-button cg-button-primary"
              href={order.confirmationUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                if (!order.test)
                  trackProductEvent(
                    "payment_redirected",
                    { surface: "wallet" },
                    order.orderId,
                  );
              }}
            >
              {order.test ? "Открыть тестовую оплату" : "Перейти к оплате"}
            </a>
          </p>
        </div>
      )}
      {attempt && (
        <Button type="button" disabled={locked} onClick={check}>
          {attempt.orderId ? "Проверить платёж" : "Найти платёж"}
        </Button>
      )}
      {canCreate && terminal && (
        <Button
          type="button"
          variant="secondary"
          disabled={locked}
          onClick={() => {
            try {
              sessionStorage.removeItem(key);
              setAttempt(null);
              frozenCreate.current = null;
              setReceiptEmail("");
              setPopupNotice("");
              setOrder(null);
              setError("");
            } catch {
              setError(
                "Не удалось начать новое пополнение. Обновите страницу.",
              );
            }
          }}
        >
          Пополнить ещё
        </Button>
      )}
      {attempt && !terminal && <p>После оплаты нажмите «Проверить платёж».</p>}
      {attempt && (
        <details>
          <summary>Данные для поддержки</summary>
          <p>Номер обращения: {attempt.requestId}</p>
          {order && <p>Номер платежа: {order.orderId}</p>}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

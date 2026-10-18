"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  formatMoneyMicros,
  type CreateTopupInput,
  type TopupOrder,
} from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import {
  parsePaymentAttempt,
  paymentAmountKopeks,
  type PaymentAttempt,
} from "./payment-attempt";

export type TopupActions = {
  createTopup: (input: CreateTopupInput) => Promise<TopupOrder>;
  topupOrder: (orderId: string) => Promise<TopupOrder>;
  reconcileTopup: (orderId: string) => Promise<TopupOrder>;
  onCredited: () => Promise<void>;
};

const statusLabels: Record<TopupOrder["status"], string> = {
  creating: "Платёж создаётся. Повторите проверку позже.",
  pending: "Ожидается тестовая оплата.",
  succeeded: "ЮKassa подтвердила тестовую оплату.",
  canceled: "Тестовый платёж отменён.",
  review_required:
    "Нужна проверка владельцем сервиса. Новый платёж пока не создавайте.",
};

/** A test-only checkout inside the existing balance card, not a return-URL handler. */
export function TestTopupPanel({
  userId,
  actions,
  disabled,
}: {
  userId: string;
  actions: TopupActions;
  disabled: boolean;
}) {
  const [amount, setAmount] = useState("100");
  const [attempt, setAttempt] = useState<PaymentAttempt | null>(null);
  const [order, setOrder] = useState<TopupOrder | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const key = `citygo.test-topup.${userId}`;
  useEffect(() => {
    let active = true;
    const loadedRevision = revision.current;
    try {
      const saved = parsePaymentAttempt(sessionStorage.getItem(key));
      // Check that an ambiguous create can be safely retried after a reload.
      sessionStorage.setItem(`${key}.probe`, "1");
      sessionStorage.removeItem(`${key}.probe`);
      setAttempt(saved);
      setReady(true);
      if (saved) setAmount(String(saved.amountKopeks / 100));
      if (saved?.orderId) {
        void actions
          .topupOrder(saved.orderId)
          .then((value) => {
            if (active && loadedRevision === revision.current) setOrder(value);
          })
          .catch(() => {
            if (active && loadedRevision === revision.current)
              setError(
                "Не удалось загрузить платёж. Проверьте его состояние кнопкой ниже.",
              );
          });
      }
    } catch {
      setError(
        "Не удалось безопасно восстановить платёж. Не создавайте повторный платёж: обратитесь к владельцу сервиса. Для нового платежа требуется доступное хранилище вкладки.",
      );
    }
    return () => {
      active = false;
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
        "Не удалось подтвердить результат. Повторите проверку; при повторе создания используется прежний ID, новый платёж автоматически не создаётся.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    const amountKopeks = paymentAmountKopeks(amount);
    if (!ready || amountKopeks === null || attempt?.orderId) return;
    void work(async () => {
      const next = attempt ?? { requestId: crypto.randomUUID(), amountKopeks };
      // Persist before the network call, including requests with an unknown result.
      sessionStorage.setItem(key, JSON.stringify(next));
      setAttempt(next);
      const value = await actions.createTopup(next);
      const saved = { ...next, orderId: value.orderId };
      setOrder(value);
      setAttempt(saved);
      sessionStorage.setItem(key, JSON.stringify(saved));
      if (value.credited) await actions.onCredited();
    });
  }

  function check() {
    if (!attempt?.orderId) return;
    void work(async () => {
      const value = await actions.reconcileTopup(attempt.orderId!);
      setOrder(value);
      if (value.credited) await actions.onCredited();
    });
  }
  const locked = disabled || pending;
  const terminal =
    order?.status === "canceled" ||
    (order?.status === "succeeded" && order.credited);
  return (
    <section aria-label="Тестовое пополнение ЮKassa">
      <h3>Тестовое пополнение ЮKassa</h3>
      <p>
        Это проверка подключения: настоящие деньги не списываются. Тестовый
        платёж не оплачивает реальные запросы к AI. Реальные пополнения пока
        недоступны.
      </p>
      <form onSubmit={create}>
        <label>
          Сумма, ₽ CityGo{" "}
          <input
            aria-label="Сумма тестового пополнения"
            inputMode="decimal"
            value={amount}
            disabled={locked || !!attempt}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <p>
          От 1 до 10 000 ₽. Тестовая оплата 100 ₽ соответствует 100 ₽ CityGo, не
          1 000 ₽.
        </p>
        {!attempt?.orderId && (
          <Button
            type="submit"
            disabled={locked || !ready || paymentAmountKopeks(amount) === null}
          >
            {attempt
              ? "Повторить создание с прежним ID"
              : "Создать тестовый платёж"}
          </Button>
        )}
      </form>
      {attempt && <p>ID попытки: {attempt.requestId}</p>}
      {order && (
        <div role="status">
          <p>{statusLabels[order.status]}</p>
          <p>
            {formatMoneyMicros(order.creditMicros)} ₽ CityGo ·{" "}
            {order.credited
              ? "тестовое зачисление подтверждено сервером"
              : "зачисление не подтверждено"}
          </p>
          <p>ID платежа: {order.orderId}</p>
        </div>
      )}
      {order?.confirmationUrl && order.status === "pending" && (
        <p>
          <a
            href={order.confirmationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть тестовую оплату ЮKassa
          </a>
        </p>
      )}
      {attempt?.orderId && (
        <Button type="button" disabled={locked} onClick={check}>
          Проверить тестовый платёж
        </Button>
      )}
      {terminal && (
        <Button
          type="button"
          variant="secondary"
          disabled={locked}
          onClick={() => {
            try {
              sessionStorage.removeItem(key);
              setAttempt(null);
              setOrder(null);
              setError("");
            } catch {
              setError(
                "Не удалось сбросить завершённую попытку. Новый платёж не создан.",
              );
            }
          }}
        >
          Новый тестовый платёж
        </Button>
      )}
      <p>
        Возвращение со страницы оплаты не означает зачисление. Проверка
        выполняется сервером по данным ЮKassa.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

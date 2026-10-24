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

export type TopupActions = {
  createTopup: (input: CreateTopupInput) => Promise<TopupOrder>;
  topupOrder: (orderId: string) => Promise<TopupOrder>;
  topupAttempt: (requestId: string) => Promise<TopupOrder>;
  reconcileTopup: (orderId: string) => Promise<TopupOrder>;
  onCredited: () => Promise<void>;
};

const statusLabels: Record<TopupOrder["status"], string> = {
  creating: "Платёж создаётся. Повторите проверку позже.",
  pending: "Ожидается оплата.",
  succeeded: "ЮKassa подтвердила оплату.",
  canceled: "Платёж отменён.",
  review_required:
    "Нужна проверка владельцем сервиса. Новый платёж пока не создавайте.",
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
      setError(
        "Укажите действующий email покупателя для отправки чека ЮKassa.",
      );
      return;
    }
    // Keep the browser's user activation: allocate the safe blank tab before
    // work() or a network call can await. Recovery/read-only paths never do this.
    const popup = openPaymentPopup();
    pendingPopup.current = popup;
    setPopupNotice(
      popup.opened
        ? "Готовим оплату в отдельной вкладке…"
        : "Браузер не открыл отдельную вкладку. После создания платежа нажмите кнопку оплаты ниже.",
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
        const saved = { ...next, orderId: value.orderId };
        setOrder(value);
        setAttempt(saved);
        sessionStorage.setItem(key, JSON.stringify(saved));
        const opened = popup.navigate(value);
        setPopupNotice(
          value.status === "pending" && value.confirmationUrl
            ? opened
              ? "Оплата открыта в отдельной вкладке. Если вкладка не появилась, нажмите кнопку оплаты ниже."
              : "Отдельная вкладка не открылась или была закрыта. Нажмите кнопку оплаты ниже — новый платёж не создаётся."
            : "Платёж сейчас не ожидает оплаты. Вкладка закрыта; проверьте состояние платежа в CityGo.",
        );
        if (value.credited) await actions.onCredited();
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
    <section className="citygo-topup" aria-label="Пополнение баланса ЮKassa">
      <h3>Пополнение баланса ЮKassa</h3>
      <p>
        Оплата 100 ₽ пополняет баланс на 100 ₽ CityGo. Создание платежа ещё не
        списывает деньги и не подтверждает зачисление. Проверьте сумму и режим
        ниже перед переходом на страницу ЮKassa.
      </p>
      {!canCreate && (
        <p role="status">
          Приём новых платежей временно закрыт. Сохранённую попытку можно
          проверить; новый платёж автоматически не создаётся.
        </p>
      )}
      {canCreate && (
        <form onSubmit={create}>
          <Field
            label="Сумма пополнения"
            hint="Сумма в рублях CityGo"
            inputMode="decimal"
            value={amount}
            disabled={locked || !!attempt}
            onChange={(event) => setAmount(event.target.value)}
          />
          {!attempt && (
            <Field
              label="Email для чека ЮKassa"
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
          {!attempt && (
            <p>
              Укажите свой действующий email: ЮKassa отправит чек на этот адрес.
              Это не подтверждение владения email. В хранилище вкладки
              сохраняются только ID попытки, сумма и ID созданного платежа.
            </p>
          )}
          <p>
            От 1 до 10 000 ₽. Оплата 100 ₽ соответствует 100 ₽ CityGo, не 1 000
            ₽.
          </p>
          {!attempt?.orderId && (!attempt || frozenCreate.current) && (
            <Button
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
              {attempt ? "Повторить создание с прежним ID" : "Создать платёж"}
            </Button>
          )}
        </form>
      )}
      {attempt && <p>ID попытки: {attempt.requestId}</p>}
      {popupNotice && <p role="status">{popupNotice}</p>}
      {attempt && !attempt.orderId && !frozenCreate.current && (
        <p>
          Результат создания не подтверждён. Повторное создание сейчас
          недоступно: исходный email для чека не хранится в браузере. Не
          оплачивайте заново: сообщите владельцу сервиса ID сохранённой попытки
          для проверки.
        </p>
      )}
      {order && (
        <div role="status">
          <p>
            {order.test
              ? "Тестовый режим: настоящие деньги не списываются. Тестовый баланс не оплачивает реальные AI-запросы."
              : "Боевой платёж: на странице ЮKassa будут списаны настоящие деньги."}
          </p>
          <p>{statusLabels[order.status]}</p>
          <p>
            {formatMoneyMicros(order.creditMicros)} ₽ CityGo ·{" "}
            {order.credited
              ? "зачисление подтверждено сервером"
              : "зачисление не подтверждено"}
          </p>
          <p>ID платежа: {order.orderId}</p>
        </div>
      )}
      {order?.confirmationUrl && order.status === "pending" && (
        <div>
          {!canCreate && (
            <p>
              Ссылка относится к ранее созданному платежу. Перед продолжением
              проверьте его состояние кнопкой «Проверить платёж» и не
              оплачивайте повторно, если деньги уже списаны.
            </p>
          )}
          <p>
            <a
              className="cg-button cg-button-primary"
              href={order.confirmationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {order.test
                ? "Открыть тестовую оплату ЮKassa"
                : "Перейти к оплате ЮKassa"}
            </a>
          </p>
        </div>
      )}
      {attempt && (
        <Button type="button" disabled={locked} onClick={check}>
          {attempt.orderId ? "Проверить платёж" : "Найти сохранённый платёж"}
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
                "Не удалось сбросить завершённую попытку. Новый платёж не создан.",
              );
            }
          }}
        >
          Новый платёж
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

"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  subscribeBrowserSessionChange,
  type SessionTicket,
} from "@citygo/api-client";
import {
  createPaymentRefundSchema,
  reconcilePaymentRefundSchema,
  paymentRefundStatusSchema,
  adminPaymentSourceQuerySchema,
  type AdminPaymentRefundDetail,
  type CreatePaymentRefundInput,
  type PaymentRefundListQuery,
} from "@citygo/contracts";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";
import { createReceiptPanelGuard, receiptMoney } from "./npd-receipts-state.js";
import {
  refundKopeks,
  sourceRefundable,
  refundCanSubmit,
  refundCanReconcile,
  refundMicros,
} from "./payment-refunds-state.js";

type Api = ReturnType<typeof createClient>;
type RefundPage = Awaited<ReturnType<Api["adminPaymentRefunds"]>>;
type Sources = Awaited<ReturnType<Api["adminPaymentSources"]>>;
type Status = NonNullable<PaymentRefundListQuery["status"]>;
const names: Record<Status, string> = {
  reserved: "Средства зарезервированы; запрос не отправлен",
  unknown: "Результат отправки неизвестен; резерв сохранён",
  pending: "Возврат обрабатывается провайдером",
  succeeded: "Возврат подтверждён сервером",
  canceled: "Отмена подтверждена сервером",
  review_required: "Нужна ручная сверка; резерв не освобождать вслепую",
};

export function PaymentRefundsControl({
  viewerId,
  onAccessLost,
}: {
  viewerId: string;
  onAccessLost: () => void;
}) {
  const [guard] = useState(createReceiptPanelGuard);
  const [page, setPage] = useState<RefundPage | null>(null);
  const [detail, setDetail] = useState<AdminPaymentRefundDetail | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [userId, setUserId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [amount, setAmount] = useState("1,00");
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<Status | "">("");
  const [after, setAfter] = useState<string | undefined>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unknownCreate, setUnknownCreate] = useState(false);
  const [canRetryIntent, setCanRetryIntent] = useState(false);
  const intent = useRef<CreatePaymentRefundInput | null>(null);
  const running = useRef<object | null>(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => guard.capture().signal,
        onUnauthorized: () => deny(),
      }),
    [guard],
  );
  function clearForms() {
    setSources(null);
    setUserId("");
    setSourceId("");
    setAmount("1,00");
    setConfirmed(false);
  }
  function invalidate(clearIntent = true) {
    guard.reset();
    running.current = null;
    setPage(null);
    setDetail(null);
    clearForms();
    setAfter(undefined);
    setPrevious([]);
    setBusy(false);
    setError("");
    setNotice("");
    setCanRetryIntent(false);
    if (clearIntent) {
      intent.current = null;
      setUnknownCreate(false);
    }
  }
  function deny() {
    invalidate();
    onAccessLost();
  }
  useEffect(() => {
    const reset = () => invalidate();
    const unsubscribe = subscribeBrowserSessionChange(reset);
    window.addEventListener("focus", reset);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", reset);
      guard.reset();
      running.current = null;
      intent.current = null;
    };
  }, [guard]);
  async function currentViewer(ticket: SessionTicket) {
    const result = await api.dashboard();
    ticket.check();
    if (
      result.user.id !== viewerId ||
      !["admin", "super_admin"].includes(result.user.role ?? "")
    ) {
      deny();
      return false;
    }
    return true;
  }
  async function run<T>(
    work: () => Promise<T>,
    apply: (result: T) => void,
    options: { mutation?: boolean; selection?: boolean; create?: boolean } = {},
  ) {
    if (running.current) return;
    const ticket = options.selection ? guard.select() : guard.capture();
    const operation = {};
    running.current = operation;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!(await currentViewer(ticket))) return;
      const result = await work();
      ticket.check();
      apply(result);
    } catch (failure) {
      if (ticket.active()) {
        if (failure instanceof ApiError && failure.status === 403) deny();
        else {
          setDetail(null);
          setSources(null);
          setSourceId("");
          setConfirmed(false);
          if (options.mutation) {
            setPage(null);
            clearForms();
            if (options.create) {
              setUnknownCreate(true);
              setCanRetryIntent(false);
            }
            setError(
              "Результат операции не подтверждён. Обновите журнал и проверьте существующий возврат. Средства могли остаться в резерве: не создавайте новый возврат и не повторяйте отправку вслепую.",
            );
          } else
            setError(
              "Не удалось проверить серверное состояние. Обновите журнал перед действием; старые формы скрыты.",
            );
        }
      }
    } finally {
      if (ticket.active() && running.current === operation) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  async function load(
    nextAfter?: string,
    history: (string | undefined)[] = [],
  ) {
    if (running.current) return;
    invalidate(false);
    await run(
      () =>
        api.adminPaymentRefunds({
          ...(status ? { status } : {}),
          ...(nextAfter ? { after: nextAfter } : {}),
          limit: 20,
        }),
      (result) => {
        setPage(result);
        setAfter(nextAfter);
        setPrevious(history);
        const existing =
          intent.current &&
          result.refunds.find(
            (refund) => refund.requestId === intent.current!.requestId,
          );
        if (existing) {
          intent.current = null;
          setUnknownCreate(false);
          setNotice(
            `Найден ранее созданный возврат ${existing.id}. Откройте его; новый резерв не создавался.`,
          );
        } else setCanRetryIntent(Boolean(intent.current));
      },
    );
  }
  async function reserve(input: CreatePaymentRefundInput) {
    if (running.current) return;
    intent.current ??= input;
    const original = intent.current;
    await run(
      () => api.createPaymentRefund(original),
      (result) => {
        intent.current = null;
        setUnknownCreate(false);
        setCanRetryIntent(false);
        setDetail(result);
        setPage(null);
        clearForms();
        setNotice(
          "Сервер вернул состояние резерва. Запрос провайдеру выполняется только отдельной кнопкой отправки; это ещё не успешный возврат.",
        );
      },
      { mutation: true, selection: true, create: true },
    );
  }
  async function mutate(kind: "submit" | "reconcile", candidate = "") {
    if (!detail || running.current) return;
    const id = detail.refund.id;
    await run(
      () =>
        kind === "submit"
          ? api.submitPaymentRefund(id)
          : api.reconcilePaymentRefund(
              id,
              candidate ? { candidateProviderRefundId: candidate } : {},
            ),
      (result) => {
        setDetail(result);
        setPage(null);
        clearForms();
        setNotice(
          "Состояние возврата обновлено сервером. Доставка и коррекция НПД-чека этим действием не подтверждаются.",
        );
      },
      { mutation: true, selection: true },
    );
  }
  const selected = sources?.sources.find(
    (source) => source.sourceOperationId === sourceId,
  );
  const amountKopeks = refundKopeks(amount);
  const eligible = selected && sourceRefundable(selected, amountKopeks);
  const sourceQuery = adminPaymentSourceQuerySchema.safeParse({ userId });
  return (
    <Card>
      <h2>Возвраты · тестовый контур ЮKassa</h2>
      <p>
        Сейчас действия доступны только для sandbox-источников. Настоящие деньги
        не возвращаются. Подарки и старый неразмеченный баланс не возвращаются;
        разрешён только свободный оплаченный остаток конкретного платежа, без
        AI-резервов и расходов.
      </p>
      <p>
        Резервирование, отправка запроса и серверная сверка — разные шаги.
        Неизвестный результат не освобождает средства. Коррекция НПД и передача
        документов ведутся отдельно в ручном реестре.
      </p>
      <SelectField
        label="Состояние возвратов"
        value={status}
        disabled={busy}
        onChange={(event) => {
          const value = event.target.value;
          if (
            value !== "" &&
            !paymentRefundStatusSchema.safeParse(value).success
          )
            return;
          invalidate(false);
          setStatus(value as Status | "");
        }}
      >
        <option value="">Все состояния</option>
        {paymentRefundStatusSchema.options.map((value) => (
          <option value={value} key={value}>
            {names[value]}
          </option>
        ))}
      </SelectField>
      <Button disabled={busy} onClick={() => void load()}>
        Обновить журнал возвратов
      </Button>
      {busy && <p role="status">Проверяем серверное состояние…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {unknownCreate && (
        <p role="alert">
          Резервирование могло выполниться. Сначала обновите журнал; при
          необходимости повторяется только тот же запрос с прежним ID, не новый
          возврат.
        </p>
      )}
      {unknownCreate && canRetryIntent && (
        <Button
          disabled={busy}
          onClick={() => {
            if (intent.current) void reserve(intent.current);
          }}
        >
          Повторить резервирование с прежним ID
        </Button>
      )}
      {page && (
        <>
          <h3>Страница {previous.length + 1}</h3>
          {page.refunds.length ? (
            <ul>
              {page.refunds.map((refund) => (
                <li key={refund.id}>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setDetail(null);
                      void run(
                        () => api.adminPaymentRefund(refund.id),
                        setDetail,
                        { selection: true },
                      );
                    }}
                  >
                    Открыть возврат {refund.id}
                  </Button>
                  <p>
                    {receiptMoney(refund.amountKopeks)} · аккаунт{" "}
                    {refund.userId} ·{" "}
                    {refund.test
                      ? "sandbox"
                      : "реальный источник; действия выключены"}{" "}
                    · {names[refund.status]}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>Возвратов в этой выборке нет.</p>
          )}
          <Button
            variant="secondary"
            disabled={busy || !previous.length}
            onClick={() => void load(previous.at(-1), previous.slice(0, -1))}
          >
            Предыдущая страница возвратов
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !page.nextAfter}
            onClick={() => {
              if (page.nextAfter)
                void load(page.nextAfter, [...previous, after]);
            }}
          >
            Следующая страница возвратов
          </Button>
        </>
      )}
      <h3>Свободные оплаченные источники</h3>
      <Field
        label="ID аккаунта для выбора оплаченного источника"
        value={userId}
        inputMode="numeric"
        disabled={busy || unknownCreate}
        onChange={(event) => {
          setUserId(event.target.value.trim());
          setSources(null);
          setSourceId("");
          setConfirmed(false);
        }}
      />
      <Button
        variant="secondary"
        disabled={busy || unknownCreate || !sourceQuery.success}
        onClick={() => {
          if (!sourceQuery.success) return;
          setSources(null);
          setSourceId("");
          setConfirmed(false);
          void run(
            () => api.adminPaymentSources(sourceQuery.data.userId),
            setSources,
          );
        }}
      >
        Показать оплаченные источники
      </Button>
      {sources && (
        <>
          {sources.truncated && (
            <p role="alert">
              Показаны только первые 100 источников, выборка неполная. Это не
              полный список и не общий остаток аккаунта.
            </p>
          )}
          {!sources.sources.length && (
            <p>
              Оплаченных размеченных источников не найдено. Подарок и
              legacy-баланс здесь не показываются.
            </p>
          )}
          <SelectField
            label="Исходный платёж для возврата"
            value={sourceId}
            disabled={busy || unknownCreate}
            onChange={(event) => {
              setSourceId(event.target.value);
              setConfirmed(false);
            }}
          >
            <option value="">Выберите источник</option>
            {sources.sources.map((source) => (
              <option
                key={source.sourceOperationId}
                value={source.sourceOperationId}
                disabled={!source.test || source.availableMicros < 1_000_000}
              >
                {source.sourceOperationId} · до{" "}
                {receiptMoney(Math.floor(source.availableMicros / 10_000))} ·{" "}
                {source.test ? "sandbox" : "реальный; недоступен"}
              </option>
            ))}
          </SelectField>
        </>
      )}
      {selected && (
        <fieldset disabled={busy || unknownCreate}>
          <legend>Резерв по конкретной оплате</legend>
          <p>
            Операция {selected.sourceOperationId}; аккаунт {selected.userId};
            ЮKassa {selected.providerPaymentId}. Источник{" "}
            {selected.test ? "sandbox" : "реальный — действия выключены"}.
          </p>
          <dl>
            <dt>Оплачено</dt>
            <dd>{refundMicros(selected.grossMicros)}</dd>
            <dt>Свободно</dt>
            <dd>{refundMicros(selected.availableMicros)}</dd>
            <dt>Потрачено / удержано AI</dt>
            <dd>
              {refundMicros(selected.spentMicros)} /{" "}
              {refundMicros(selected.heldMicros)}
            </dd>
            <dt>Резерв возвратов / возвращено</dt>
            <dd>
              {refundMicros(selected.refundReservedMicros)} /{" "}
              {refundMicros(selected.refundedMicros)}
            </dd>
          </dl>
          <p>
            Максимум нового возврата:{" "}
            {receiptMoney(Math.floor(selected.availableMicros / 10_000))}.
            Остатки меньше копейки не округляются вверх.
          </p>
          <Field
            label="Сумма возврата в рублях"
            value={amount}
            inputMode="decimal"
            maxLength={16}
            onChange={(event) => {
              setAmount(event.target.value);
              setConfirmed(false);
            }}
            hint="Текущий технический порог теста — 1 ₽; это не юридическое ограничение суммы возврата."
          />
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            Подтверждаю резервирование выбранной суммы из этого sandbox-платежа,
            без отправки провайдеру.
          </label>
          <Button
            disabled={!confirmed || !eligible || !amountKopeks}
            onClick={() => {
              if (!confirmed || !eligible || amountKopeks === null) return;
              const parsed = createPaymentRefundSchema.safeParse({
                requestId: crypto.randomUUID(),
                paymentOperationId: selected.sourceOperationId,
                amountKopeks,
              });
              if (parsed.success) void reserve(parsed.data);
            }}
          >
            Зарезервировать тестовый возврат
          </Button>
        </fieldset>
      )}
      {detail && (
        <RefundDetail
          key={`${detail.refund.id}-${detail.refund.revision}`}
          detail={detail}
          busy={busy}
          onSubmit={() => void mutate("submit")}
          onReconcile={(candidate) => void mutate("reconcile", candidate)}
        />
      )}
    </Card>
  );
}

function RefundDetail({
  detail,
  busy,
  onSubmit,
  onReconcile,
}: {
  detail: AdminPaymentRefundDetail;
  busy: boolean;
  onSubmit: () => void;
  onReconcile: (candidate: string) => void;
}) {
  const refund = detail.refund;
  const [confirmed, setConfirmed] = useState(false);
  const [candidate, setCandidate] = useState("");
  const candidateInput = reconcilePaymentRefundSchema.safeParse(
    candidate.trim() ? { candidateProviderRefundId: candidate.trim() } : {},
  );
  return (
    <section aria-label="Детали возврата">
      <h3>Возврат {refund.id}</h3>
      <p>
        {names[refund.status]}.{" "}
        {refund.test
          ? "Sandbox: настоящие деньги не переводятся."
          : "Реальный источник: управление выключено."}
      </p>
      <dl>
        <dt>Сумма</dt>
        <dd>{receiptMoney(refund.amountKopeks)}</dd>
        <dt>Аккаунт</dt>
        <dd>{refund.userId}</dd>
        <dt>Исходная операция</dt>
        <dd>{refund.paymentOperationId}</dd>
        <dt>ЮKassa: платёж / возврат</dt>
        <dd>
          {refund.providerPaymentId} /{" "}
          {refund.providerRefundId ?? "ID ещё не установлен"}
        </dd>
        <dt>Магазин</dt>
        <dd>{refund.merchantId}</dd>
        <dt>ID намерения</dt>
        <dd>{refund.requestId}</dd>
        <dt>Ревизия / попытки отправки</dt>
        <dd>
          {refund.revision} / {refund.attemptCount}
        </dd>
        <dt>Последняя попытка</dt>
        <dd>
          {refund.lastAttemptAt
            ? new Date(refund.lastAttemptAt).toLocaleString("ru-RU")
            : "не было"}
        </dd>
        <dt>Создан / обновлён</dt>
        <dd>
          {new Date(refund.createdAt).toLocaleString("ru-RU")} /{" "}
          {new Date(refund.updatedAt).toLocaleString("ru-RU")}
        </dd>
      </dl>
      {refund.reviewReason && (
        <p role="alert">
          Причина серверной сверки: {refund.reviewReason}. Не освобождайте
          резерв и не повторяйте запрос вслепую.
        </p>
      )}
      {refundCanSubmit(refund) && (
        <fieldset disabled={busy}>
          <legend>Отдельная отправка в sandbox ЮKassa</legend>
          <p>
            Подтверждён только резерв. Эта кнопка делает внешний запрос в
            тестовую ЮKassa; успешный ответ создания сам по себе не подтверждает
            завершённый возврат.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            Подтверждаю отдельную отправку этого тестового возврата.
          </label>
          <Button
            disabled={!confirmed}
            onClick={() => {
              if (confirmed) onSubmit();
            }}
          >
            Отправить тестовый возврат
          </Button>
        </fieldset>
      )}
      {refundCanReconcile(refund) && (
        <fieldset disabled={busy}>
          <legend>Проверка существующего возврата без новой отправки</legend>
          <p>
            Сервер выполняет проверочный GET. Введённый ID — только кандидат для
            сверки, не доказательство платежа, успешного возврата или коррекции
            НПД.
          </p>
          {!refund.providerRefundId && (
            <Field
              label="ID существующего возврата ЮKassa для серверной сверки (необязательно)"
              value={candidate}
              maxLength={36}
              onChange={(event) => setCandidate(event.target.value)}
            />
          )}
          <Button
            disabled={!candidateInput.success}
            onClick={() => {
              if (candidateInput.success)
                onReconcile(refund.providerRefundId ? "" : candidate.trim());
            }}
          >
            Сверить существующий возврат
          </Button>
        </fieldset>
      )}
      <p>
        Нет кнопки «отметить успешным». Денежный результат берётся только из
        проверки провайдера. Ручная коррекция НПД-чека и его доставка
        подтверждаются отдельно.
      </p>
      <h4>Аудит возврата · до 200 событий</h4>
      <ol>
        {detail.events.map((event) => (
          <li key={event.sequence}>
            <details>
              <summary>
                {new Date(event.createdAt).toLocaleString("ru-RU")} ·{" "}
                {event.action} · ревизия {event.revision}
              </summary>
              <p>
                Оператор {event.actorUserId ?? "серверная операция"} · событие{" "}
                {event.sequence}
              </p>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import {
  npdReceiptCommandSchema,
  type AdminNpdReceiptDetail,
  type AdminNpdReceiptTask,
  type NpdReceiptCommand,
  type NpdReceiptListQuery,
} from "@citygo/contracts";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";
import { createReceiptPanelGuard, receiptMoney } from "./npd-receipts-state.js";

type ReceiptPage = Awaited<
  ReturnType<ReturnType<typeof createClient>["adminNpdReceipts"]>
>;
type Status = NonNullable<NpdReceiptListQuery["status"]>;
const statusNames: Record<Status, string> = {
  pending: "Ожидают регистрации",
  registered: "Регистрация заявлена оператором",
  correction_required: "Нужна коррекция после возврата",
  review: "Нужна ручная проверка",
};
const reviewNames = {
  registration_uncertain: "Неизвестен результат регистрации",
  delivery_uncertain: "Передача не состоялась или результат неизвестен",
  correction_uncertain: "Неизвестен результат коррекции",
};
const actionNames = {
  claim: "Задача принята в работу",
  register: "Оператор сообщил о регистрации чека",
  delivery: "Оператор сообщил о передаче чека",
  review: "Отмечена ручная проверка",
  correction: "Оператор сообщил о коррекции",
  refund_observed: "Зафиксирован подтверждённый возврат",
};
function date(value: string) {
  return new Date(value).toLocaleString("ru-RU");
}

export function NpdReceiptsControl({
  viewerId,
  onAccessLost,
}: {
  viewerId: string;
  onAccessLost: () => void;
}) {
  const [guard] = useState(createReceiptPanelGuard);
  const [page, setPage] = useState<ReceiptPage | null>(null);
  const [detail, setDetail] = useState<AdminNpdReceiptDetail | null>(null);
  const [status, setStatus] = useState<Status | "">("");
  const [currentAfter, setCurrentAfter] = useState<string | undefined>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef<object | null>(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => guard.capture().signal,
        onUnauthorized: () => deny(),
      }),
    [guard],
  );
  function invalidate() {
    guard.reset();
    running.current = null;
    setPage(null);
    setDetail(null);
    setCurrentAfter(undefined);
    setPrevious([]);
    setBusy(false);
    setError("");
    setNotice("");
  }
  function deny() {
    invalidate();
    onAccessLost();
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(invalidate);
    window.addEventListener("focus", invalidate);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", invalidate);
      guard.reset();
      running.current = null;
    };
  }, [guard]);

  async function load(after?: string, history: (string | undefined)[] = []) {
    if (running.current) return;
    invalidate();
    const ticket = guard.capture();
    const operation = {};
    running.current = operation;
    setBusy(true);
    try {
      const dashboard = await api.dashboard();
      ticket.check();
      if (
        dashboard.user.id !== viewerId ||
        !["admin", "super_admin"].includes(dashboard.user.role ?? "")
      ) {
        deny();
        return;
      }
      const result = await api.adminNpdReceipts({
        ...(status ? { status } : {}),
        ...(after ? { after } : {}),
        limit: 20,
      });
      ticket.check();
      setPage(result);
      setCurrentAfter(after);
      setPrevious(history);
    } catch (failure) {
      if (ticket.active()) {
        if (failure instanceof ApiError && failure.status === 403) deny();
        else
          setError(
            "Не удалось загрузить реестр. Проверьте соединение и обновите его; старые данные и формы скрыты.",
          );
      }
    } finally {
      if (ticket.active() && running.current === operation) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  async function open(taskId: string) {
    if (running.current) return;
    const ticket = guard.select();
    const operation = {};
    running.current = operation;
    setBusy(true);
    setDetail(null);
    setError("");
    setNotice("");
    try {
      const result = await api.adminNpdReceipt(taskId);
      ticket.check();
      setDetail(result);
    } catch (failure) {
      if (ticket.active()) {
        if (failure instanceof ApiError && failure.status === 403) deny();
        else
          setError(
            "Не удалось загрузить задачу. Обновите реестр перед действием.",
          );
      }
    } finally {
      if (ticket.active() && running.current === operation) {
        running.current = null;
        setBusy(false);
      }
    }
  }
  async function command(input: NpdReceiptCommand) {
    if (running.current || !detail) return;
    const taskId = detail.task.id;
    const ticket = guard.select();
    const operation = {};
    running.current = operation;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.commandNpdReceipt(taskId, input);
      ticket.check();
      setDetail(result);
      // A filtered page may have changed membership. Do not present it as fresh.
      setPage(null);
      setNotice(
        "Сервер сохранил запись оператора. Это не автоматическая проверка ФНС и не отправка чека. Для актуального списка обновите реестр.",
      );
    } catch (failure) {
      if (ticket.active()) {
        if (failure instanceof ApiError && failure.status === 403) deny();
        else {
          setPage(null);
          setDetail(null);
          setError(
            "Результат записи не подтверждён. Запрос мог выполниться: обновите реестр и проверьте аудит. Не оформляйте и не отправляйте чек повторно вслепую.",
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

  return (
    <Card>
      <h2>НПД · Ручной реестр чеков</h2>
      <p>
        Здесь нет выпуска чеков в ФНС, отправки писем или возврата денег.
        Сначала примите задачу в работу и проверьте историю, затем выполните
        необходимое внешнее действие в «Моём налоге» или вручную и сохраните
        фактический результат. Квитанция оплаты не заменяет чек НПД.
      </p>
      <p>
        Рубли оплаты учитываются 1:1. Подарок CityGo и себестоимость AI не
        увеличивают сумму чека. Реестр сам по себе не включает приём реальных
        платежей.
      </p>
      <SelectField
        label="Фильтр задач НПД"
        value={status}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value;
          if (next !== "" && !Object.hasOwn(statusNames, next)) return;
          invalidate();
          setStatus(next as Status | "");
        }}
      >
        <option value="">Все состояния</option>
        {Object.entries(statusNames).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>
      <Button disabled={busy} onClick={() => void load()}>
        Обновить реестр
      </Button>
      {busy && <p role="status">Проверяем серверное состояние…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {page && (
        <>
          <h3>Страница {previous.length + 1}</h3>
          {page.tasks.length ? (
            <ul>
              {page.tasks.map((task) => (
                <li key={task.id}>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void open(task.id)}
                  >
                    Открыть задачу {task.id}
                  </Button>
                  <p>
                    {receiptMoney(task.amountKopeks)} ·{" "}
                    {task.buyerEmail ?? "Email в источнике не указан"} ·{" "}
                    {date(task.observedAt)}
                  </p>
                  <TaskStatus task={task} />
                </li>
              ))}
            </ul>
          ) : (
            <p>В этой выборке задач нет.</p>
          )}
          <Button
            variant="secondary"
            disabled={busy || !previous.length}
            onClick={() => void load(previous.at(-1), previous.slice(0, -1))}
          >
            Предыдущая страница
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !page.nextAfter}
            onClick={() => {
              if (page.nextAfter)
                void load(page.nextAfter, [...previous, currentAfter]);
            }}
          >
            Следующая страница
          </Button>
        </>
      )}
      {detail && (
        <ReceiptDetail
          key={`${detail.task.id}-${detail.task.revision}`}
          detail={detail}
          viewerId={viewerId}
          busy={busy}
          onCommand={(input) => void command(input)}
        />
      )}
    </Card>
  );
}

function TaskStatus({ task }: { task: AdminNpdReceiptTask }) {
  return (
    <p>
      Регистрация:{" "}
      {task.registrationStatus === "pending"
        ? "ожидается"
        : "заявлена оператором"}
      ; передача:{" "}
      {task.deliveryStatus === "pending" ? "ожидается" : "заявлена оператором"};
      коррекция:{" "}
      {task.correctionStatus === "required"
        ? "требуется"
        : task.correctionStatus === "operator_reported"
          ? "заявлена оператором"
          : "не требуется"}
      .{task.reviewReason && <> Проверка: {reviewNames[task.reviewReason]}.</>}
    </p>
  );
}

function ReceiptDetail({
  detail,
  viewerId,
  busy,
  onCommand,
}: {
  detail: AdminNpdReceiptDetail;
  viewerId: string;
  busy: boolean;
  onCommand: (input: NpdReceiptCommand) => void;
}) {
  const task = detail.task;
  const documentLabel = task.activeReceiptId
    ? `чек ${task.activeReceiptId}`
    : "подтверждение аннулирования/коррекции";
  const own = task.claimedByUserId === viewerId;
  const [receiptId, setReceiptId] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [registered, setRegistered] = useState(false);
  const [channel, setChannel] = useState<"email" | "other_manual">("email");
  const [delivered, setDelivered] = useState(false);
  const [review, setReview] = useState<
    NonNullable<AdminNpdReceiptTask["reviewReason"]>
  >(task.reviewReason ?? "registration_uncertain");
  const [reviewed, setReviewed] = useState(false);
  const [correctionUrl, setCorrectionUrl] = useState("");
  const [replacementId, setReplacementId] = useState("");
  const [replacementUrl, setReplacementUrl] = useState("");
  const [corrected, setCorrected] = useState(false);
  const base = {
    requestId: "00000000-0000-4000-8000-000000000000",
    expectedRevision: task.revision,
  };
  const registerInput = npdReceiptCommandSchema.safeParse({
    ...base,
    action: "register",
    receiptId: receiptId.trim(),
    receiptUrl: receiptUrl.trim(),
    amountKopeks: task.amountKopeks,
    operatorReported: registered,
  });
  const deliveryInput = npdReceiptCommandSchema.safeParse({
    ...base,
    action: "delivery",
    receiptEvidenceId: task.activeEvidenceId,
    channel,
    operatorReported: delivered,
  });
  const reviewInput = npdReceiptCommandSchema.safeParse({
    ...base,
    action: "review",
    reason: review,
  });
  const correctionInput = npdReceiptCommandSchema.safeParse({
    ...base,
    action: "correction",
    refundSnapshotKopeks: task.cumulativeRefundedKopeks,
    canceledReceiptId: task.activeReceiptId,
    evidenceUrl: correctionUrl.trim(),
    replacement:
      task.remainingIncomeKopeks > 0
        ? {
            receiptId: replacementId.trim(),
            receiptUrl: replacementUrl.trim(),
            amountKopeks: task.remainingIncomeKopeks,
          }
        : null,
    operatorReported: corrected,
  });
  function send(input: NpdReceiptCommand) {
    if (!busy) onCommand({ ...input, requestId: crypto.randomUUID() });
  }
  return (
    <section aria-label="Детали задачи НПД">
      <h3>Задача {task.id}</h3>
      <dl>
        <dt>Источник</dt>
        <dd>ЮKassa · платёж {task.paymentId}</dd>
        <dt>Аккаунт покупателя</dt>
        <dd>{task.userId}</dd>
        <dt>Email аккаунта покупателя (не подтверждён источником оплаты)</dt>
        <dd>
          {task.buyerEmail ?? "Не указан. Не выдумывайте адрес передачи."}
        </dd>
        <dt>Исходная оплата</dt>
        <dd>{receiptMoney(task.amountKopeks)}</dd>
        <dt>Подтверждённые возвраты</dt>
        <dd>{receiptMoney(task.cumulativeRefundedKopeks)}</dd>
        <dt>Оставшийся доход по оплате</dt>
        <dd>{receiptMoney(task.remainingIncomeKopeks)}</dd>
        <dt>Наблюдение источника</dt>
        <dd>{date(task.observedAt)}</dd>
        <dt>Создана / обновлена</dt>
        <dd>
          {date(task.createdAt)} / {date(task.updatedAt)}
        </dd>
        <dt>Ревизия сервера</dt>
        <dd>{task.revision}</dd>
        <dt>Ответственный</dt>
        <dd>{own ? "Вы" : (task.claimedByUserId ?? "Не назначен")}</dd>
      </dl>
      <TaskStatus task={task} />
      <p>
        Состояния «заявлено оператором» — ручная фиксация, не независимая
        проверка ФНС.
      </p>
      <p>
        Email взят из аккаунта CityGo, не из подтверждённых платёжных данных.
        Проверьте адрес передачи. Ссылка в личном кабинете сама по себе не
        подтверждает фактическую передачу чека покупателю.
      </p>
      {task.activeReceiptUrl && (
        <p>
          {task.activeReceiptId
            ? `Текущий чек ${task.activeReceiptId}`
            : "Подтверждение аннулирования/коррекции"}
          :{" "}
          <a
            href={task.activeReceiptUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть документ ФНС
          </a>
          . После возвращения обновите реестр.
        </p>
      )}
      {task.reviewReason && (
        <p role="alert">
          Результат требует проверки: {reviewNames[task.reviewReason]}. Сначала
          проверьте существующие документы и передачу; не повторяйте внешнее
          действие вслепую.
        </p>
      )}
      {!task.claimedByUserId && (
        <Button
          disabled={busy}
          onClick={() => send({ ...base, action: "claim" })}
        >
          Принять задачу в работу
        </Button>
      )}
      {!own && (
        <p>
          {task.claimedByUserId
            ? "Задача назначена другому оператору. Изменения недоступны."
            : "Перед ручной фиксацией примите задачу в работу."}
        </p>
      )}
      {own && (
        <>
          {task.registrationStatus === "pending" && (
            <fieldset disabled={busy}>
              <legend>Фактическая регистрация исходного чека</legend>
              <p>
                Не создаёт чек. Укажите настоящий документ из «Моего налога» на
                исходную оплату {receiptMoney(task.amountKopeks)}. Если уже есть
                возврат или результат регистрации неизвестен, сначала разберите
                историю.
              </p>
              <Field
                label="ID зарегистрированного чека НПД"
                value={receiptId}
                maxLength={100}
                onChange={(event) => {
                  setReceiptId(event.target.value);
                  setRegistered(false);
                }}
              />
              <Field
                label="Ссылка на настоящий чек на lknpd.nalog.ru"
                type="url"
                value={receiptUrl}
                maxLength={2048}
                onChange={(event) => {
                  setReceiptUrl(event.target.value);
                  setRegistered(false);
                }}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={registered}
                  onChange={(event) => setRegistered(event.target.checked)}
                />{" "}
                Я действительно зарегистрировал этот чек; сумма и источник
                сверены. CityGo не проверяет его в ФНС автоматически.
              </label>
              <Button
                disabled={!registerInput.success}
                onClick={() => {
                  if (registerInput.success) send(registerInput.data);
                }}
              >
                Сохранить факт регистрации
              </Button>
            </fieldset>
          )}
          {task.activeEvidenceId &&
            task.deliveryStatus === "pending" &&
            task.correctionStatus !== "required" && (
              <fieldset disabled={busy}>
                <legend>Фактическая передача текущего документа</legend>
                <p>
                  Это не отправка письма. Сначала реально передайте покупателю{" "}
                  {documentLabel}, затем подтвердите. ID записи доказательства
                  выбирается сервером: {task.activeEvidenceId}.
                </p>
                <SelectField
                  label="Как фактически передан чек"
                  value={channel}
                  onChange={(event) => {
                    if (
                      event.target.value === "email" ||
                      event.target.value === "other_manual"
                    ) {
                      setChannel(event.target.value);
                      setDelivered(false);
                    }
                  }}
                >
                  <option value="email">Вручную по email</option>
                  <option value="other_manual">Другим ручным способом</option>
                </SelectField>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={delivered}
                    onChange={(event) => setDelivered(event.target.checked)}
                  />{" "}
                  Я действительно передал покупателю именно этот документ
                  выбранным способом.
                </label>
                <Button
                  disabled={
                    !deliveryInput.success ||
                    (channel === "email" && !task.buyerEmail)
                  }
                  onClick={() => {
                    if (deliveryInput.success) send(deliveryInput.data);
                  }}
                >
                  Сохранить факт передачи
                </Button>
              </fieldset>
            )}
          {task.correctionStatus === "required" && (
            <fieldset disabled={busy}>
              <legend>
                Ручная коррекция НПД после подтверждённого возврата
              </legend>
              <p>
                Деньги здесь не возвращаются. Сумма возвратов{" "}
                {receiptMoney(task.cumulativeRefundedKopeks)} уже зафиксирована
                источником. После коррекции должен остаться доход{" "}
                {receiptMoney(task.remainingIncomeKopeks)}. Сначала выполните и
                проверьте необходимые действия в «Моём налоге».
              </p>
              {!task.activeReceiptId && (
                <p role="alert">
                  Нет сохранённого исходного чека для коррекции. Проверьте
                  регистрацию и историю; не аннулируйте выдуманный документ.
                </p>
              )}
              <p>
                Аннулируемый исходный документ:{" "}
                {task.activeReceiptId ?? "не указан"}.
              </p>
              <Field
                label="Ссылка ФНС, подтверждающая коррекцию исходного чека"
                type="url"
                value={correctionUrl}
                maxLength={2048}
                onChange={(event) => {
                  setCorrectionUrl(event.target.value);
                  setCorrected(false);
                }}
              />
              {task.remainingIncomeKopeks > 0 && (
                <>
                  <Field
                    label="ID нового чека на оставшийся доход"
                    value={replacementId}
                    maxLength={100}
                    onChange={(event) => {
                      setReplacementId(event.target.value);
                      setCorrected(false);
                    }}
                  />
                  <Field
                    label="Ссылка ФНС на новый чек"
                    type="url"
                    value={replacementUrl}
                    maxLength={2048}
                    onChange={(event) => {
                      setReplacementUrl(event.target.value);
                      setCorrected(false);
                    }}
                  />
                  <p>
                    Сумма нового документа:{" "}
                    {receiptMoney(task.remainingIncomeKopeks)}. Это не второй
                    доход сверх исходной оплаты.
                  </p>
                </>
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={corrected}
                  onChange={(event) => setCorrected(event.target.checked)}
                />{" "}
                Я выполнил и сверил коррекцию НПД и необходимые документы.
                Необходимую повторную передачу отмечу отдельно.
              </label>
              <Button
                disabled={!correctionInput.success}
                onClick={() => {
                  if (correctionInput.success) send(correctionInput.data);
                }}
              >
                Сохранить факт коррекции
              </Button>
            </fieldset>
          )}
          <fieldset disabled={busy}>
            <legend>Неизвестный результат или сбой передачи</legend>
            <p>
              Не отмечайте действие выполненным без фактического результата.
              Фиксация проверки не выпускает, не аннулирует и не отправляет чек.
            </p>
            <SelectField
              label="Причина ручной проверки"
              value={review}
              onChange={(event) => {
                if (Object.hasOwn(reviewNames, event.target.value)) {
                  setReview(event.target.value as typeof review);
                  setReviewed(false);
                }
              }}
            >
              {Object.entries(reviewNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </SelectField>
            <label className="check">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />{" "}
              Подтверждаю необходимость проверки без повторения внешнего
              действия.
            </label>
            <Button
              disabled={!reviewed || !reviewInput.success}
              onClick={() => {
                if (reviewed && reviewInput.success) send(reviewInput.data);
              }}
            >
              Отметить ручную проверку
            </Button>
          </fieldset>
        </>
      )}
      <h4>Аудит · события сервера</h4>
      <p>
        Серверная выборка содержит не более 200 событий. Это журнал записей
        оператора и наблюдений источника, не независимая проверка ФНС.
      </p>
      {!detail.events.length && <p>Событий ручной обработки пока нет.</p>}
      <ol>
        {detail.events.map((event) => (
          <li key={event.requestId}>
            <details>
              <summary>
                {date(event.createdAt)} · {actionNames[event.action]} · ревизия{" "}
                {event.revision}
              </summary>
              <p>
                Запрос {event.requestId} · оператор{" "}
                {event.actorUserId ?? "системное наблюдение источника"}
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

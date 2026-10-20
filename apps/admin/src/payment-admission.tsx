"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  createClient,
  createSessionGuard,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import {
  paymentAdmissionCommandSchema,
  paymentAdmissionStatusSchema,
  type PaymentAdmissionCommand,
  type PaymentAdmissionStatus,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";

type AdmissionApi = Pick<
  ReturnType<typeof createClient>,
  "dashboard" | "paymentAdmission" | "commandPaymentAdmission"
>;
type Intent =
  | { action: "open"; manualNpdResponsibilityAccepted: boolean }
  | { action: "close" }
  | { action: "set_reconciliation"; enabled: boolean };
type Snapshot = {
  status: PaymentAdmissionStatus | null;
  busy: boolean;
  error: string;
  notice: string;
};
const empty: Snapshot = { status: null, busy: false, error: "", notice: "" };

// Browser commands never carry merchant IDs, runtime bindings or health stamps.
export function paymentAdmissionCommandFor(
  status: PaymentAdmissionStatus,
  intent: Intent,
  requestId: string,
): PaymentAdmissionCommand {
  const common = { requestId, expectedRevision: status.revision };
  const parsed = paymentAdmissionCommandSchema.safeParse(
    intent.action === "open"
      ? {
          ...common,
          action: "open",
          mode: "continuous",
          manualNpdResponsibilityAccepted:
            intent.manualNpdResponsibilityAccepted,
        }
      : intent.action === "close"
        ? { ...common, action: "close" }
        : { ...common, action: "set_reconciliation", enabled: intent.enabled },
  );
  if (!parsed.success)
    throw new Error("Не подтверждена команда допуска оплаты");
  return parsed.data;
}

// One lifetime per mounted viewer. Invalidation also defeats transports that
// ignore AbortSignal; neither late GET nor late POST may revive an old form.
export function createPaymentAdmissionPanel(
  viewerId: string,
  onAccessLost: () => void,
  makeApi: (options: {
    signal: () => AbortSignal;
    onUnauthorized: () => void;
  }) => AdmissionApi = (options) => createClient("/api", options),
) {
  const guard = createSessionGuard();
  const listeners = new Set<() => void>();
  let snapshot = empty;
  let running: object | null = null;
  function publish(value: Snapshot) {
    snapshot = value;
    for (const listener of listeners) listener();
  }
  function invalidate() {
    guard.reset();
    running = null;
    publish(empty);
  }
  function deny() {
    invalidate();
    onAccessLost();
  }
  const api = makeApi({
    signal: () => guard.capture().signal,
    onUnauthorized: deny,
  });
  async function verifyViewer(ticket: ReturnType<typeof guard.capture>) {
    const { user } = await api.dashboard();
    ticket.check();
    if (
      user.id !== viewerId ||
      user.role !== "super_admin" ||
      user.mustChangePassword !== false
    ) {
      deny();
      return false;
    }
    return true;
  }
  async function run(intent?: Intent) {
    if (running) return;
    let command: PaymentAdmissionCommand | undefined;
    if (intent) {
      if (!snapshot.status) return;
      try {
        command = paymentAdmissionCommandFor(
          snapshot.status,
          intent,
          crypto.randomUUID(),
        );
      } catch {
        publish({
          ...snapshot,
          error:
            intent.action === "open" && !intent.manualNpdResponsibilityAccepted
              ? "Для непрерывного приёма нужно явно принять ответственность за ручные НПД-чеки."
              : "Не удалось подготовить безопасную команду для текущей ревизии. Обновите состояние перед действием.",
        });
        return;
      }
    }
    // Unknown results are resolved by a fresh GET, never an automatic POST retry.
    invalidate();
    const ticket = guard.capture();
    const operation = {};
    running = operation;
    publish({ ...empty, busy: true });
    try {
      if (!(await verifyViewer(ticket))) return;
      const result = command
        ? await api.commandPaymentAdmission(command)
        : await api.paymentAdmission();
      ticket.check();
      const status = paymentAdmissionStatusSchema.parse(result);
      // Revalidate after responses too: roles/cookies can change while a
      // request is in flight without producing a browser notification.
      if (!(await verifyViewer(ticket))) return;
      publish({
        ...empty,
        status,
        busy: true,
        notice: command
          ? "Сервер сохранил настройку допуска. Проверяйте фактическую доступность ниже: команда не проводит платёж, возврат или оформление чека."
          : "",
      });
    } catch (failure) {
      if (ticket.active()) {
        if (
          failure instanceof ApiError &&
          (failure.status === 401 || failure.status === 403)
        )
          deny();
        else
          publish({
            ...empty,
            busy: true,
            error: command
              ? failure instanceof ApiError && failure.status === 409
                ? "Допуск изменился. Обновите состояние и заново подтвердите действие; старая форма скрыта."
                : "Результат команды не подтверждён: она могла выполниться. Обновите состояние перед новым действием. Автоматического повтора нет."
              : "Не удалось прочитать допуск. Старые данные скрыты; обновите состояние перед действием.",
          });
      }
    } finally {
      if (ticket.active() && running === operation) {
        running = null;
        publish({ ...snapshot, busy: false });
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate,
    load: () => run(),
    command: (intent: Intent) => run(intent),
  };
}

const reasons: Record<NonNullable<PaymentAdmissionStatus["reason"]>, string> = {
  closed: "Новые пополнения закрыты оператором.",
  binding_mismatch:
    "Настройка не связана с текущим магазином и runtime-профилем.",
  operator_inactive:
    "У ответственного нет актуальных прав super admin или требуется смена пароля.",
  lease_expired: "Временный допуск истёк или связанная сессия завершена.",
  reconciliation_disabled: "Серверная сверка выключена.",
  reconciliation_unhealthy:
    "Последняя доверенная сверка не подтвердила исправность.",
  reconciliation_stale: "Нет достаточно свежей доверенной серверной сверки.",
};
const modes = {
  closed: "Закрыт",
  lease: "Временный допуск",
  continuous: "Непрерывный приём",
};
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("ru-RU")
    : "Нет подтверждённого времени";

export function PaymentAdmissionControl({
  viewerId,
  onAccessLost,
}: {
  viewerId: string;
  onAccessLost: () => void;
}) {
  const [panel] = useState(() =>
    createPaymentAdmissionPanel(viewerId, onAccessLost),
  );
  const snapshot = useSyncExternalStore(
    panel.subscribe,
    panel.getSnapshot,
    panel.getSnapshot,
  );
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(panel.invalidate);
    window.addEventListener("focus", panel.invalidate);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", panel.invalidate);
      panel.invalidate();
    };
  }, [panel]);
  return (
    <Card>
      <h2>Оплата · Допуск новых пополнений</h2>
      <p>
        Только для текущего super admin. По умолчанию приём закрыт. Просмотр
        панели и обновление состояния ничего не включают. Непрерывный режим не
        требует открытого браузера, но зависит от актуальных прав ответственного
        и исправной серверной сверки.
      </p>
      <p>
        Закрытие не отменяет уже выданные ссылки оплаты: покупатель ещё может
        оплатить по ним. Учёт состоявшихся оплат, возвратов и история
        сохраняются. Сверка управляется отдельно от допуска новых пополнений.
      </p>
      <p>
        НПД-чеки нужно реально оформлять в «Моём налоге» и передавать
        покупателю. Квитанция ЮKassa и видимость документа в CityGo не
        подтверждают передачу чека. Эта панель не отправляет письма и не
        оформляет чеки.
      </p>
      <p>
        Серверный допуск и исправная сверка не подтверждают, что ЮKassa примет
        платёж или что данные чека совместимы с настройками магазина. Отдельная
        приёмка запуска включает реальную оплату, полный возврат и проверку
        чекового пути.
      </p>
      <p>
        Принятие ответственности за ручные НПД-чеки не настраивает фискальные
        параметры магазина ЮKassa.
      </p>
      <Button disabled={snapshot.busy} onClick={() => void panel.load()}>
        {snapshot.busy ? "Проверка…" : "Обновить допуск оплаты"}
      </Button>
      {snapshot.error && (
        <p className="admin-error" role="alert">
          {snapshot.error}
        </p>
      )}
      {snapshot.notice && <p role="status">{snapshot.notice}</p>}
      {snapshot.status && (
        <AdmissionDetails
          key={`${snapshot.status.revision}-${snapshot.status.reconciliationCheckedAt}`}
          status={snapshot.status}
          busy={snapshot.busy}
          onCommand={(intent) => void panel.command(intent)}
        />
      )}
    </Card>
  );
}

function AdmissionDetails({
  status,
  busy,
  onCommand,
}: {
  status: PaymentAdmissionStatus;
  busy: boolean;
  onCommand: (intent: Intent) => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const backlog = status.npdBacklog;
  return (
    <section aria-label="Состояние допуска оплаты">
      <p role="status">
        На момент чтения:{" "}
        {status.available
          ? "серверный допуск новых пополнений открыт"
          : "новые пополнения недоступны"}
        .{status.reason && <> {reasons[status.reason]}</>}
      </p>
      <p>
        Состояние может измениться. Каждое новое пополнение отдельно проверяется
        сервером.
      </p>
      <dl>
        <dt>Ревизия сервера</dt>
        <dd>{status.revision}</dd>
        <dt>Режим</dt>
        <dd>{modes[status.mode]}</dd>
        <dt>Флаг приёма новых пополнений</dt>
        <dd>{status.acceptingNewCheckouts ? "Включён" : "Выключен"}</dd>
        <dt>Ответственный аккаунт</dt>
        <dd>{status.ownerUserId ?? "Не назначен"}</dd>
        <dt>Ответственность за ручные НПД-чеки</dt>
        <dd>
          {status.manualNpdResponsibilityAccepted
            ? "Принята ответственным"
            : "Не подтверждена"}
        </dd>
        <dt>Связь с текущим магазином и runtime-профилем</dt>
        <dd>
          {status.runtimeBindingMatches ? "Совпадает" : "Не подтверждена"}
        </dd>
        <dt>Серверная сверка</dt>
        <dd>
          {status.reconciliationEnabled ? "Включена" : "Выключена"}; результат:{" "}
          {status.reconciliationOk
            ? "исправен по последней проверке"
            : "исправность не подтверждена"}
        </dd>
        <dt>Последняя доверенная сверка</dt>
        <dd>{date(status.reconciliationCheckedAt)}</dd>
        {status.mode === "lease" && (
          <>
            <dt>Срок временного допуска</dt>
            <dd>{date(status.leaseUntil)}</dd>
          </>
        )}
      </dl>
      <h3>Незавершённая ручная обработка НПД</h3>
      <p>
        Задач всего: {backlog.total}; ожидают регистрации:{" "}
        {backlog.pendingRegistration}; передачи: {backlog.pendingDelivery};
        коррекции: {backlog.requiredCorrection}; ручной проверки:{" "}
        {backlog.review}. Одна задача может входить в несколько категорий.
      </p>
      <p>
        Самое раннее наблюдение источника:{" "}
        {backlog.oldestObservedAt
          ? date(backlog.oldestObservedAt)
          : backlog.total === 0
            ? "Задач нет"
            : "Время не подтверждено"}
        . Это не время оплаты и не налоговый срок. Нулевой список сам по себе не
        доказывает соблюдение сроков.
      </p>
      <fieldset disabled={busy}>
        <legend>Непрерывный приём новых пополнений</legend>
        <p>
          Сначала включите сверку, дождитесь её результата и обновите допуск.
          Затем отдельно подтвердите непрерывный приём. Одного включённого флага
          недостаточно: все условия проверяет сервер.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />{" "}
          Я лично принимаю ответственность за своевременное ручное оформление,
          передачу НПД-чеков и коррекции после возвратов при непрерывном приёме.
          Открытый браузер не является условием приёма оплаты.
        </label>
        <Button
          disabled={
            !accepted ||
            !status.runtimeBindingMatches ||
            !status.reconciliationEnabled ||
            !status.reconciliationOk
          }
          onClick={() =>
            onCommand({
              action: "open",
              manualNpdResponsibilityAccepted: accepted,
            })
          }
        >
          Подтвердить непрерывный приём
        </Button>
        <Button
          variant="secondary"
          onClick={() => onCommand({ action: "close" })}
        >
          Закрыть новые пополнения
        </Button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Серверная сверка существующих операций</legend>
        <p>
          Сверка получает подтверждённые состояния ранее созданных операций.
          Включение сверки не открывает приём новых пополнений и не создаёт
          новый платёж или возврат. Приостановка сверки блокирует новые
          пополнения и может задержать учёт существующих операций.
        </p>
        <Button
          variant="secondary"
          onClick={() =>
            onCommand({
              action: "set_reconciliation",
              enabled: !status.reconciliationEnabled,
            })
          }
        >
          {status.reconciliationEnabled
            ? "Приостановить серверную сверку"
            : "Включить серверную сверку"}
        </Button>
      </fieldset>
    </section>
  );
}

"use client";
import * as React from "react";
import { createClient } from "@citygo/api-client";
import {
  creditUserIdSchema,
  type OwnerNpdReceiptTask,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import {
  createOwnerReceiptsResource,
  ownerReceiptPresentation,
  receiptLoadError,
  type OwnerReceiptsState,
} from "./owner-receipts-state";

async function loadOwnerReceipts(signal: AbortSignal) {
  return createClient("/api", { signal: () => signal }).npdReceipts();
}

function observedDate(value: string) {
  return `${new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

export function OwnerReceiptList({
  tasks,
}: {
  tasks: readonly OwnerNpdReceiptTask[];
}) {
  return (
    <ul>
      {tasks.map((task) => {
        const view = ownerReceiptPresentation(task);
        return (
          <li key={task.id}>
            <h3>Чек по пополнению</h3>
            <details>
              <summary>Данные для поддержки</summary>
              <p>Номер оплаты: {task.paymentId}</p>
            </details>
            <dl>
              <dt>Оплачено</dt>
              <dd>{view.paid}</dd>
              <dt>Возвращено</dt>
              <dd>{view.refunded}</dd>
              <dt>Сумма после возвратов</dt>
              <dd>{view.remaining}</dd>
              <dt>Дата подтверждения оплаты</dt>
              <dd>{observedDate(task.observedAt)}</dd>
            </dl>
            <ul>
              {view.statuses.map((status) => (
                <li key={status}>{status}</li>
              ))}
            </ul>
            {view.uncertainDocument && <p>Чек уточняется после возврата.</p>}
            {view.link && (
              <p>
                <a
                  href={view.link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {view.link.label}
                </a>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Mount only for the authenticated owner; pass the parent's current session signal. */
export function OwnerReceiptsPanel({
  userId,
  sessionSignal,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied?: () => void;
}) {
  const [snapshot, setSnapshot] = React.useState<{
    userId: string;
    signal: AbortSignal;
    state: OwnerReceiptsState;
  } | null>(null);
  const resource = React.useRef<ReturnType<
    typeof createOwnerReceiptsResource
  > | null>(null);
  const denied = React.useRef(onAccessDenied);
  React.useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  React.useEffect(() => {
    // Older compatible dashboard IDs need not be numeric. Receipt ownership
    // cannot be inferred from them; fail this panel closed, not the whole app.
    if (!creditUserIdSchema.safeParse(userId).success) return;
    const current = createOwnerReceiptsResource({
      userId,
      sessionSignal,
      load: loadOwnerReceipts,
      publish: (state) => setSnapshot({ userId, signal: sessionSignal, state }),
      onAccessDenied: () => denied.current?.(),
    });
    resource.current = current;
    void current.refresh();
    return () => {
      current.dispose();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, sessionSignal]);
  // Suppress previous-owner data on the render BEFORE effect cleanup as well.
  const state = !creditUserIdSchema.safeParse(userId).success
    ? { phase: "error" as const, tasks: [] }
    : sessionSignal.aborted
      ? { phase: "closed" as const, tasks: [] }
      : snapshot?.userId === userId && snapshot.signal === sessionSignal
        ? snapshot.state
        : { phase: "loading" as const, tasks: [] };
  return (
    <Card aria-label="Мои чеки">
      <h2>Мои чеки</h2>
      <p>Чеки по пополнениям и возвратам.</p>
      {state.phase === "loading" && <p role="status">Загружаем чеки…</p>}
      {state.phase === "error" && <p role="alert">{receiptLoadError}</p>}
      {state.phase === "closed" && (
        <p role="status">Войдите снова, чтобы увидеть чеки.</p>
      )}
      {state.phase === "ready" &&
        (state.tasks.length ? (
          <>
            <p>Последние чеки</p>
            <OwnerReceiptList tasks={state.tasks} />
          </>
        ) : (
          <p role="status">
            Чеков пока нет. Если оплата прошла, а чек не появился, обратитесь в
            поддержку.
          </p>
        ))}
      <Button
        type="button"
        variant="secondary"
        disabled={state.phase === "loading" || state.phase === "closed"}
        onClick={() => void resource.current?.refresh()}
      >
        Обновить чеки
      </Button>
    </Card>
  );
}

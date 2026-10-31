"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import {
  formatSignedMoneyMicros,
  type BalanceHistoryEntry,
  type BalanceHistoryFilter,
} from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import {
  createBalanceHistoryResource,
  emptyBalanceHistory,
  type BalanceHistoryState,
} from "./balance-history-state";
import styles from "./balance-history.module.css";
const labels: Record<BalanceHistoryFilter, string> = {
  all: "Все операции",
  gift: "Подарок",
  topup: "Пополнение",
  spend: "Списание",
  refund: "Возврат",
};
const formatDate = (value: string) =>
  new Date(value).toLocaleString("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  });
export function BalanceHistoryPanel({
  userId,
  sessionSignal,
  onAccessDenied,
  onClose,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    state: BalanceHistoryState;
  } | null>(null);
  const resource = useRef<ReturnType<
      typeof createBalanceHistoryResource
    > | null>(null),
    denied = useRef(onAccessDenied),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  useEffect(() => {
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = createBalanceHistoryResource({
      userId,
      signal,
      client: createClient("/api", { signal: () => signal }),
      publish: (state) =>
        setSnapshot({ owner: userId, signal: sessionSignal, state }),
      onAccessDenied: () => denied.current(),
    });
    signal.addEventListener("abort", () => setSnapshot(null), { once: true });
    resource.current = current;
    heading.current?.focus();
    void current.refresh();
    return () => {
      current.dispose();
      controller.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, sessionSignal]);
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : emptyBalanceHistory;
  if (sessionSignal.aborted) return null;
  return (
    <section
      className={styles.panel + " ym-hide-content"}
      aria-labelledby="balance-history-title"
      aria-busy={state.busy}
    >
      <Button type="button" variant="secondary" onClick={onClose}>
        Назад к балансу
      </Button>
      <h2 id="balance-history-title" tabIndex={-1} ref={heading}>
        История баланса
      </h2>
      <div className={styles.filters} role="group" aria-label="Вид операции">
        {(Object.keys(labels) as BalanceHistoryFilter[]).map((filter) => (
          <Button
            type="button"
            key={filter}
            variant={filter === state.filter ? "primary" : "secondary"}
            aria-pressed={filter === state.filter}
            onClick={() => void resource.current?.filter(filter)}
          >
            {labels[filter]}
          </Button>
        ))}
      </div>
      {state.error && <p role="alert">{state.error}</p>}
      {state.busy && <p role="status">Загружаем операции…</p>}
      {state.loaded && !state.entries.length && (
        <p role="status">Таких операций пока нет.</p>
      )}
      {!!state.entries.length && (
        <ul className={styles.list} aria-label="Операции баланса">
          {state.entries.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        {state.nextCursor && (
          <Button
            type="button"
            variant="secondary"
            disabled={state.busy}
            onClick={() => void resource.current?.loadMore()}
          >
            Показать ещё
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={state.busy}
          onClick={() => void resource.current?.refresh()}
        >
          Обновить историю
        </Button>
      </div>
    </section>
  );
}
function HistoryRow({ entry }: { entry: BalanceHistoryEntry }) {
  return (
    <li className={styles.row}>
      <div>
        <strong>{labels[entry.kind]}</strong>
        <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
      </div>
      <strong
        className={entry.direction === "credit" ? styles.credit : styles.debit}
      >
        {entry.direction === "credit" ? "+" : "−"}
        {formatSignedMoneyMicros(entry.amountMicros)} ₽
      </strong>
    </li>
  );
}

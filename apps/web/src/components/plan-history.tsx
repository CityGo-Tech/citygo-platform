"use client";
import { useEffect, useRef, useState } from "react";
import {
  createClient,
  createPersonalPlanHistoryResource,
  type PlanHistoryState,
} from "@citygo/api-client";
import type { PersonalPlanHistoryEntry } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import styles from "./plan-history.module.css";

function Version({
  entry,
  label,
}: {
  entry: PersonalPlanHistoryEntry;
  label: string;
}) {
  return (
    <section className={styles.version} aria-label={label}>
      <span className={styles.meta}>
        {label} · версия {entry.revision}
      </span>
      <h2>{entry.title}</h2>
      {entry.details && <p className={styles.text}>{entry.details}</p>}
      <p>{entry.status === "completed" ? "Выполнено" : "В работе"}</p>
      {entry.checklist.length > 0 && (
        <ul className={styles.checklist} aria-label="Сохранённый чек-лист">
          {entry.checklist.map((row) => (
            <li key={row.id}>
              <span aria-label={row.completed ? "Выполнено" : "Не выполнено"}>
                {row.completed ? "✓" : "○"}
              </span>{" "}
              <strong>{row.title}</strong>
              {row.details && <p className={styles.text}>{row.details}</p>}
            </li>
          ))}
        </ul>
      )}
      <small>
        {entry.initialSnapshot
          ? "Начало сохранённой истории · "
          : "Сохранено · "}
        {new Date(entry.recordedAt).toLocaleString("ru-RU")}
      </small>
    </section>
  );
}

export function PlanItemHistory({
  userId,
  itemId,
  sessionSignal,
  onBack,
  onAccessDenied,
}: {
  userId: string;
  itemId: string;
  sessionSignal: AbortSignal;
  onBack: () => void;
  onAccessDenied: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    item: string;
    signal: AbortSignal;
    state: PlanHistoryState;
  } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const resource = useRef<ReturnType<
    typeof createPersonalPlanHistoryResource
  > | null>(null);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setSelected(null);
    heading.current?.focus({ preventScroll: true });
    const controller = new AbortController();
    const current = createPersonalPlanHistoryResource({
      userId,
      itemId,
      signal: AbortSignal.any([sessionSignal, controller.signal]),
      read: (before, signal) =>
        createClient("/api", { signal: () => signal }).personalPlanHistory(
          itemId,
          before,
        ),
      publish: (state) =>
        setSnapshot({
          owner: userId,
          item: itemId,
          signal: sessionSignal,
          state,
        }),
      onAccessDenied: () => denied.current(),
    });
    resource.current = current;
    void current.load();
    return () => {
      current.dispose();
      controller.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, itemId, sessionSignal]);
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.item === itemId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  if (sessionSignal.aborted || state?.phase === "closed") return null;
  const busy = !state || state.phase === "loading";
  const previous =
    state?.entries.find(
      (entry) =>
        entry.revision === selected &&
        entry.revision !== state.current?.revision,
    ) ??
    state?.entries.find((entry) => entry.revision !== state.current?.revision);
  return (
    <Card
      className={styles.panel + " ym-hide-content"}
      aria-label="История изменений шага"
      aria-busy={busy}
    >
      <h1 ref={heading} tabIndex={-1}>
        Что изменилось
      </h1>
      <p>Сравните сохранённые версии. Просмотр не изменяет ваш шаг.</p>
      <Button variant="secondary" onClick={onBack}>
        ← В мой план
      </Button>
      {busy && <p role="status">Загружаем историю…</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.phase === "error" && (
        <Button onClick={() => void resource.current?.load()}>
          Обновить историю
        </Button>
      )}
      {state?.current && (
        <>
          <div className={styles.choices} aria-label="Версии шага">
            {state.entries
              .filter((entry) => entry.revision !== state.current?.revision)
              .map((entry) => (
                <Button
                  key={entry.revision}
                  variant={
                    previous?.revision === entry.revision
                      ? "primary"
                      : "secondary"
                  }
                  aria-pressed={previous?.revision === entry.revision}
                  disabled={busy}
                  onClick={() => setSelected(entry.revision)}
                >
                  Версия {entry.revision}
                </Button>
              ))}
          </div>
          <div className={styles.compare}>
            <Version entry={state.current} label="Текущая версия" />
            {previous ? (
              <Version entry={previous} label="Выбранная версия" />
            ) : (
              <section className={styles.version}>
                <h2>Предыдущих версий пока нет</h2>
                <p>Они появятся после сохранения изменений.</p>
              </section>
            )}
          </div>
          {(state.current.initialSnapshot ||
            state.entries.some((entry) => entry.initialSnapshot)) && (
            <p className={styles.hint}>
              Более ранние изменения не восстанавливались. История начинается с
              фактически сохранённого состояния.
            </p>
          )}
          <div className={styles.choices}>
            {state.nextBefore !== null && (
              <Button
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  void resource.current?.earlier();
                }}
              >
                Более ранние версии
              </Button>
            )}
            {state.entries[0]?.revision !== state.current.revision && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setSelected(null);
                  void resource.current?.load();
                }}
              >
                К последним версиям
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

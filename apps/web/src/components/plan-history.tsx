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
import dialogStyles from "./assistant-handoff.module.css";

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

function RestoreConfirmation({
  entry,
  revision,
  busy,
  signal,
  trigger,
  onConfirm,
  onClose,
}: {
  entry: PersonalPlanHistoryEntry;
  revision: number;
  busy: boolean;
  signal: AbortSignal;
  trigger: HTMLButtonElement | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!signal.aborted) {
      element?.showModal();
      element
        ?.querySelector<HTMLButtonElement>("[data-restore-cancel]")
        ?.focus();
    }
    return () => {
      element?.close();
      if (!signal.aborted && trigger?.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, [signal, trigger]);
  return (
    <dialog
      ref={dialog}
      className={dialogStyles.dialog + " ym-hide-content ym-disable-keys"}
      aria-labelledby="plan-restore-title"
      data-citygo-private
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <Card className={dialogStyles.card}>
        <h2 id="plan-restore-title">Восстановить версию {entry.revision}?</h2>
        <p>
          Она заменит название, описание, статус и чек-лист шага. Текущая версия{" "}
          {revision} сохранится в истории.
        </p>
        <Version entry={entry} label="Будет восстановлено" />
        {busy && <p role="status">Восстанавливаем версию…</p>}
        <div className={dialogStyles.actions}>
          <Button disabled={busy} onClick={onConfirm}>
            Подтвердить восстановление
          </Button>
          <Button
            data-restore-cancel
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </Button>
        </div>
      </Card>
    </dialog>
  );
}

export function PlanItemHistory({
  userId,
  itemId,
  sessionSignal,
  onBack,
  onAccessDenied,
  onRestored,
}: {
  userId: string;
  itemId: string;
  sessionSignal: AbortSignal;
  onBack: () => void;
  onAccessDenied: () => void;
  onRestored: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    item: string;
    signal: AbortSignal;
    state: PlanHistoryState;
  } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState<{
    entry: PersonalPlanHistoryEntry;
    revision: number;
    trigger: HTMLButtonElement;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const resource = useRef<ReturnType<
    typeof createPersonalPlanHistoryResource
  > | null>(null);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setSelected(null);
    setPending(null);
    setNotice("");
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
      restore: (command, signal) =>
        createClient("/api", {
          signal: () => signal,
        }).restorePersonalPlanRevision(itemId, command),
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
  const busy =
    !state || state.phase === "loading" || state.phase === "restoring";
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
      {state?.phase === "loading" && <p role="status">Загружаем историю…</p>}
      {notice && <p role="status">{notice}</p>}
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.phase === "error" && (
        <Button
          onClick={() => {
            setSelected(null);
            setNotice("");
            void resource.current?.load();
          }}
        >
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
          {previous && (
            <Button
              disabled={busy}
              onClick={(event) => {
                setNotice("");
                setPending({
                  entry: previous,
                  revision: state.current!.revision,
                  trigger: event.currentTarget,
                });
              }}
            >
              Восстановить выбранную версию
            </Button>
          )}
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
      {pending &&
        state?.current &&
        (state.phase === "ready" || state.phase === "restoring") && (
          <RestoreConfirmation
            entry={pending.entry}
            revision={pending.revision}
            busy={busy}
            signal={sessionSignal}
            trigger={pending.trigger}
            onClose={() => setPending(null)}
            onConfirm={() => {
              const restoring = resource.current;
              if (restoring?.snapshot().phase !== "ready") return;
              void restoring
                .restore(pending.entry.revision, pending.revision)
                .then((restored) => {
                  if (sessionSignal.aborted || resource.current !== restoring)
                    return;
                  setPending(null);
                  if (restored) {
                    setSelected(null);
                    setNotice(
                      "Версия восстановлена. Предыдущие изменения сохранены в истории.",
                    );
                    onRestored();
                  }
                });
            }}
          />
        )}
    </Card>
  );
}

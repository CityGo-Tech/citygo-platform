"use client";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { Button } from "@citygo/ui-web";
import type { Message } from "@citygo/contracts";
import type { ConversationHistoryState } from "./conversation-history-state";
import styles from "./conversation-history.module.css";

export function ConversationHistoryControls({
  state,
  disabled,
  onOlder,
  onLatest,
}: {
  state?: ConversationHistoryState | null;
  disabled: boolean;
  onOlder?: () => Promise<void>;
  onLatest?: () => void;
}) {
  if (!state || state.phase === "closed") return null;
  return (
    <div className={styles.controls} aria-label="Навигация по истории">
      {state.detached && (
        <div className={styles.notice} role="status">
          <p>
            Вы просматриваете раннюю историю. Отправка нового вопроса доступна в
            последних сообщениях.
          </p>
          <Button type="button" variant="secondary" onClick={onLatest}>
            К последним сообщениям
          </Button>
        </div>
      )}
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
      {state.nextCursor && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || state.phase === "loading"}
          onClick={() => void onOlder?.()}
        >
          {state.phase === "loading"
            ? "Загружаем ранние сообщения…"
            : state.phase === "error"
              ? "Повторить загрузку ранних сообщений"
              : "Загрузить ранние сообщения"}
        </Button>
      )}
      {state.phase === "loading" && (
        <small role="status">
          Загружаем сохранённую историю. Запрос к ИИ не отправляется.
        </small>
      )}
      {state.loadedPages > 0 && !state.nextCursor && (
        <p className={styles.end} role="status">
          Начало диалога. Более ранних сообщений нет.
        </p>
      )}
    </div>
  );
}

/** Restore the same visible row after a prepend, not an assumed row height. */
export function useHistoryScrollAnchor(
  log: RefObject<HTMLDivElement | null>,
  messages: readonly Message[],
  options: {
    threadId?: string;
    detached?: boolean;
    draft?: string;
    pending?: string;
    view?: string;
  } = {},
) {
  const anchor = useRef<{
    id: string;
    top: number;
    first: string | undefined;
  } | null>(null);
  const previous = useRef<{
    threadId?: string;
    detached?: boolean;
    first?: string;
    view?: string;
    height: number;
    client: number;
  } | null>(null);
  const returning = useRef(false);
  const first = messages[0]?.id;
  const last = messages.at(-1)?.id;
  useLayoutEffect(() => {
    const saved = anchor.current,
      viewport = log.current;
    if (!viewport) return;
    const before = previous.current;
    if (saved && first !== saved.first && !returning.current) {
      anchor.current = null;
      const row = [
        ...viewport.querySelectorAll<HTMLElement>("[data-history-message]"),
      ].find((element) => element.dataset.historyMessage === saved.id);
      if (row) {
        const difference = row.getBoundingClientRect().top - saved.top;
        const overflow = window.getComputedStyle(viewport).overflowY;
        if (overflow === "auto" || overflow === "scroll")
          viewport.scrollTop += difference;
        else window.scrollBy({ top: difference, behavior: "instant" });
      }
    } else if (!options.detached) {
      const nearBottom =
        !before || before.height - viewport.scrollTop - before.client < 48;
      const reset =
        !before ||
        before.threadId !== options.threadId ||
        before.detached ||
        before.view !== options.view ||
        returning.current;
      if (reset || nearBottom || options.draft || options.pending)
        viewport.scrollTop = viewport.scrollHeight;
    }
    returning.current = false;
    previous.current = {
      threadId: options.threadId,
      detached: options.detached,
      first,
      view: options.view,
      height: viewport.scrollHeight,
      client: viewport.clientHeight,
    };
  }, [
    first,
    last,
    messages.length,
    log,
    options.threadId,
    options.detached,
    options.draft,
    options.pending,
    options.view,
  ]);
  async function loadOlder(action?: () => Promise<void>) {
    const viewport = log.current;
    if (!viewport || !action) return;
    const top = Math.max(0, viewport.getBoundingClientRect().top);
    const rows = [
      ...viewport.querySelectorAll<HTMLElement>("[data-history-message]"),
    ];
    const row =
      rows.find((element) => element.getBoundingClientRect().bottom > top) ??
      rows[0];
    if (row)
      anchor.current = {
        id: row.dataset.historyMessage!,
        top: row.getBoundingClientRect().top,
        first,
      };
    await action();
  }
  return {
    loadOlder,
    returnToLatest(action?: () => void) {
      anchor.current = null;
      returning.current = true;
      action?.();
    },
  };
}
export { styles as conversationHistoryStyles };

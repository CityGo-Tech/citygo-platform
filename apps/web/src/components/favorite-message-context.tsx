"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import type { FavoriteMessage } from "@citygo/contracts";
import { AssistantMessage, Button, Card } from "@citygo/ui-web";
import { agentNames } from "./agent-names";
import {
  createFavoriteContextResource,
  type FavoriteContextState,
} from "./favorite-message-context-state";
import { useHistoryScrollAnchor } from "./conversation-history";
import styles from "./favorite-message-context.module.css";

export function FavoriteMessageContext({
  userId,
  source,
  sessionSignal,
  onBack,
  onAccessDenied,
  onOpenConversation,
}: {
  userId: string;
  source: FavoriteMessage;
  sessionSignal: AbortSignal;
  onBack: () => void;
  onAccessDenied: () => void;
  onOpenConversation?: (threadId: string) => Promise<boolean>;
}) {
  const [state, setState] = useState<FavoriteContextState>({
    phase: "loading",
    messages: [],
    nextCursor: null,
    trimmed: false,
    error: "",
  });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const resource = useRef<ReturnType<
    typeof createFavoriteContextResource
  > | null>(null);
  const denied = useRef(onAccessDenied);
  const log = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const openingLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  useEffect(() => {
    mounted.current = true;
    focused.current = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    const value = createFavoriteContextResource({
      userId,
      threadId: source.threadId,
      messageId: source.id,
      sessionSignal: signal,
      context: (requestSignal) =>
        createClient("/api", {
          signal: () => requestSignal,
        }).conversationMessageContext(source.threadId, source.id),
      older: (before) => api.conversationMessages(source.threadId, before),
      publish: setState,
      onAccessDenied: () => denied.current(),
    });
    resource.current = value;
    void value.loadSource();
    return () => {
      mounted.current = false;
      value.dispose();
      controller.abort();
      if (resource.current === value) resource.current = null;
    };
  }, [userId, source.threadId, source.id, sessionSignal]);
  const scroll = useHistoryScrollAnchor(log, state.messages, {
    threadId: source.threadId,
    detached: true,
  });
  useEffect(() => {
    if (state.phase === "ready" && selected.current && !focused.current) {
      focused.current = true;
      selected.current.focus({ preventScroll: true });
      selected.current.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }, [state.phase]);
  if (sessionSignal.aborted || state.phase === "closed") return null;
  const busy = state.phase === "loading" || opening;
  async function openConversation() {
    if (
      !onOpenConversation ||
      openingLock.current ||
      busy ||
      !state.messages.length
    )
      return;
    openingLock.current = true;
    setOpening(true);
    setOpenError("");
    try {
      const opened = await onOpenConversation(source.threadId);
      if (mounted.current && !sessionSignal.aborted && !opened)
        setOpenError("Не удалось открыть диалог. Попробуйте ещё раз.");
    } catch {
      if (mounted.current && !sessionSignal.aborted)
        setOpenError("Не удалось открыть диалог. Попробуйте ещё раз.");
    } finally {
      openingLock.current = false;
      if (mounted.current && !sessionSignal.aborted) setOpening(false);
    }
  }
  return (
    <Card
      className={styles.panel}
      aria-label="Исходный диалог"
      aria-busy={busy}
    >
      <span className="eyebrow">ИЗ ИЗБРАННОГО</span>
      <h1>Сообщение в диалоге</h1>
      <p className={styles.intro}>История перед сохранённым сообщением.</p>
      <Button variant="secondary" disabled={opening} onClick={onBack}>
        ← В избранное
      </Button>
      {state.error && <p role="alert">{state.error}</p>}
      {openError && <p role="alert">{openError}</p>}
      {state.phase === "loading" && <p role="status">Загружаем историю…</p>}
      {state.phase === "error" && (
        <Button
          variant="secondary"
          disabled={opening}
          onClick={() => void resource.current?.retry()}
        >
          Повторить загрузку
        </Button>
      )}
      {state.nextCursor && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void scroll.loadOlder(
              () => resource.current?.loadOlder() ?? Promise.resolve(),
            )
          }
        >
          Загрузить ранние сообщения
        </Button>
      )}
      {state.trimmed && (
        <div className={styles.notice} role="status">
          <p>Показана ранняя часть истории.</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              focused.current = false;
              void resource.current?.loadSource();
            }}
          >
            К сохранённому сообщению
          </Button>
        </div>
      )}
      <div
        className={styles.messages}
        ref={log}
        role="log"
        aria-label="История исходного диалога"
        aria-live="off"
      >
        {state.messages.map((message) => (
          <article
            key={message.id}
            ref={message.id === source.id ? selected : undefined}
            tabIndex={message.id === source.id ? -1 : undefined}
            data-history-message={message.id}
            data-source-message={
              message.id === source.id ? message.id : undefined
            }
            aria-current={message.id === source.id ? true : undefined}
            className={
              "conversation-message " +
              (message.id === source.id ? styles.selected : "")
            }
            aria-label={
              message.id === source.id
                ? "Сохранённое сообщение в диалоге"
                : undefined
            }
          >
            {message.id === source.id && (
              <small className={styles.label}>Сохранённое сообщение</small>
            )}
            <strong>
              {message.role === "user" ? "Вы" : agentNames[message.agentKey]}
            </strong>
            {message.role === "user" ? (
              <p>{message.content}</p>
            ) : (
              <AssistantMessage content={message.content} />
            )}
            {message.status === "interrupted" && <small>Ответ прерван</small>}
          </article>
        ))}
      </div>
      {onOpenConversation && state.messages.length > 0 && (
        <Button disabled={busy} onClick={() => void openConversation()}>
          Открыть весь диалог
        </Button>
      )}
    </Card>
  );
}

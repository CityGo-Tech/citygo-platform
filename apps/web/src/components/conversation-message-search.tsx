"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Field } from "@citygo/ui-web";
import { createClient } from "@citygo/api-client";
import { FavoriteMessageContext } from "./favorite-message-context";
import {
  createMessageSearchResource,
  type MessageSearchState,
} from "./conversation-message-search-state";
import styles from "./conversation-message-search.module.css";
type Scope = { userId: string; threadId: string; sessionSignal: AbortSignal };
export function ConversationMessageSearch(
  props: Scope & { disabled: boolean; onAccessDenied: () => void },
) {
  const [scope, setScope] = useState<Scope | null>(null);
  const trigger = useRef<HTMLSpanElement>(null),
    latest = useRef(props);
  latest.current = props;
  const current = (s: Scope) =>
    !latest.current.disabled &&
    !s.sessionSignal.aborted &&
    s.userId === latest.current.userId &&
    s.threadId === latest.current.threadId &&
    s.sessionSignal === latest.current.sessionSignal;
  const available = !!scope && current(scope);
  useEffect(() => {
    if (!available) setScope(null);
  }, [available]);
  return (
    <>
      <span ref={trigger}>
        <Button
          type="button"
          variant="ghost"
          disabled={props.disabled || props.sessionSignal.aborted}
          onClick={() => {
            if (
              !latest.current.disabled &&
              !latest.current.sessionSignal.aborted
            )
              setScope({ ...latest.current });
          }}
        >
          Найти в диалоге
        </Button>
      </span>
      {scope && available && (
        <SearchDialog
          scope={scope}
          onAccessDenied={props.onAccessDenied}
          onClose={() => {
            setScope(null);
            if (current(scope))
              trigger.current?.querySelector("button")?.focus();
          }}
        />
      )}
    </>
  );
}
function SearchDialog({
  scope,
  onClose,
  onAccessDenied,
}: {
  scope: Scope;
  onClose: () => void;
  onAccessDenied: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    lifetime = useRef(new AbortController());
  const signal = useMemo(
    () => AbortSignal.any([scope.sessionSignal, lifetime.current.signal]),
    [scope],
  );
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<MessageSearchState>({
    phase: "idle",
    search: "",
    matches: [],
    nextCursor: null,
    trimmed: false,
    error: "",
  });
  const resource = useRef<ReturnType<
      typeof createMessageSearchResource
    > | null>(null),
    denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  useEffect(() => {
    const value = createMessageSearchResource({
      ...scope,
      sessionSignal: signal,
      load: (search, before, requestSignal) =>
        createClient("/api", {
          signal: () => requestSignal,
        }).searchConversationMessages(scope.threadId, search, before),
      publish: setState,
      onAccessDenied: () => denied.current(),
    });
    resource.current = value;
    dialog.current?.showModal();
    dialog.current
      ?.querySelector<HTMLInputElement>('input[type="search"]')
      ?.focus();
    return () => {
      value.dispose();
      resource.current = null;
      dialog.current?.close();
    };
  }, [scope, signal]);
  function close() {
    lifetime.current.abort();
    resource.current?.dispose();
    dialog.current?.close();
    onClose();
  }
  if (signal.aborted || state.phase === "closed") return null;
  return (
    <dialog
      ref={dialog}
      className={styles.dialog + " ym-hide-content"}
      aria-labelledby="message-search-heading"
      onKeyDownCapture={(event) => {
        // Search inputs consume a first Escape to clear their native value.
        // Keep the modal's exit action consistent from every focused child.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <Card className={styles.card}>
        <h2 id="message-search-heading">Найти в диалоге</h2>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={close}>
            Вернуться к диалогу
          </Button>
        </div>
        {selected ? (
          <div className={styles.context}>
            <FavoriteMessageContext
              key={selected}
              userId={scope.userId}
              source={{ id: selected, threadId: scope.threadId }}
              sessionSignal={signal}
              onAccessDenied={() => denied.current()}
              onBack={() => {
                setSelected(null);
                requestAnimationFrame(() =>
                  dialog.current
                    ?.querySelector<HTMLInputElement>('input[type="search"]')
                    ?.focus(),
                );
              }}
              labels={{
                eyebrow: "ПОИСК В ДИАЛОГЕ",
                intro: "История перед найденным сообщением.",
                back: "← К результатам поиска",
                selected: "Найденное сообщение",
                selectedAria: "Найденное сообщение в диалоге",
                returnToSource: "К найденному сообщению",
                unavailable:
                  "Сообщение недоступно. Вернитесь к результатам поиска.",
              }}
            />
          </div>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void resource.current?.search(query);
              }}
            >
              <Field
                type="search"
                className="ym-disable-keys"
                label="Текст сообщения"
                value={query}
                maxLength={160}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button type="submit">Найти сообщения</Button>
            </form>
            {state.phase === "loading" && <p role="status">Ищем сообщения…</p>}
            {state.error && <p role="alert">{state.error}</p>}
            {state.phase === "ready" && !state.matches.length && (
              <p role="status">Сообщений с таким текстом нет.</p>
            )}
            {state.trimmed && <p>Показаны ранние совпадения.</p>}
            <div
              className={styles.matches}
              aria-label="Результаты поиска сообщений"
            >
              {state.matches.map((match) => (
                <article className={styles.match} key={match.messageId}>
                  <strong>{match.role === "user" ? "Вы" : "Помощник"}</strong>
                  <p>{match.snippet}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={state.phase === "loading"}
                    onClick={() => {
                      if (!signal.aborted) setSelected(match.messageId);
                    }}
                  >
                    Открыть сообщение
                  </Button>
                </article>
              ))}
            </div>
            {state.nextCursor && (
              <Button
                type="button"
                variant="secondary"
                disabled={state.phase === "loading"}
                onClick={() => void resource.current?.more()}
              >
                Показать ещё совпадения
              </Button>
            )}
          </>
        )}
      </Card>
    </dialog>
  );
}

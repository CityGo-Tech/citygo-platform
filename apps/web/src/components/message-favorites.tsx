"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import type {
  AgentKey,
  FavoriteMessage,
  FavoriteMessageFilters,
} from "@citygo/contracts";
import {
  AssistantMessage,
  Button,
  Card,
  Field,
  SelectField,
} from "@citygo/ui-web";
import { agentNames } from "./agent-names";
import { FavoriteMessageContext } from "./favorite-message-context";
import { trackProductEvent } from "./product-analytics";
import {
  createFavoriteMessagesResource,
  type FavoriteMessagesState,
} from "./message-favorites-state";
import styles from "./message-favorites.module.css";

export function FavoriteButton({
  saved = false,
  disabled,
  onClick,
}: {
  saved?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      aria-pressed={saved}
      disabled={disabled}
      onClick={onClick}
    >
      <Image
        src="/figma/bookmark.svg"
        alt=""
        width={20}
        height={20}
        aria-hidden="true"
      />
      {saved ? "В избранном" : "В избранное"}
    </Button>
  );
}

export function MessageFavoritesPanel({
  userId,
  sessionSignal,
  onClose,
  onAccessDenied,
  onOpenConversation,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onClose: () => void;
  onAccessDenied: () => void;
  onOpenConversation?: (threadId: string) => Promise<boolean>;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    state: FavoriteMessagesState;
  } | null>(null);
  const [draft, setDraft] = useState<{
    owner: string;
    signal: AbortSignal;
    search: string;
    assistant: AgentKey | "";
    role: "user" | "assistant" | "";
  }>({
    owner: userId,
    signal: sessionSignal,
    search: "",
    assistant: "",
    role: "",
  });
  const [source, setSource] = useState<{
    owner: string;
    signal: AbortSignal;
    message: FavoriteMessage;
  } | null>(null);
  const resource = useRef<{
    owner: string;
    signal: AbortSignal;
    value: ReturnType<typeof createFavoriteMessagesResource>;
  } | null>(null);
  const sourceButton = useRef<HTMLButtonElement | null>(null);
  const listScroll = useRef(0);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = (requestSignal: AbortSignal) =>
      createClient("/api", {
        signal: () => AbortSignal.any([signal, requestSignal]),
      });
    const value = createFavoriteMessagesResource({
      userId,
      sessionSignal: signal,
      client: {
        page: (before, filters, requestSignal) =>
          api(requestSignal).favoriteMessages(before, filters),
        remove: async (id, requestSignal) => {
          const result = await api(requestSignal).setMessageFavorite(id, false);
          if (!signal.aborted && !requestSignal.aborted)
            trackProductEvent("favorite_removed", { surface: "favorites" });
          return result;
        },
      },
      publish: (state) =>
        setSnapshot({ owner: userId, signal: sessionSignal, state }),
      onAccessDenied: () => denied.current(),
    });
    resource.current = { owner: userId, signal: sessionSignal, value };
    setDraft({
      owner: userId,
      signal: sessionSignal,
      search: "",
      assistant: "",
      role: "",
    });
    setSource(null);
    void value.load();
    return () => {
      value.dispose();
      controller.abort();
      if (resource.current?.value === value) resource.current = null;
    };
  }, [userId, sessionSignal]);
  const current =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  const liveResource = () =>
    !sessionSignal.aborted &&
    resource.current?.owner === userId &&
    resource.current.signal === sessionSignal
      ? resource.current.value
      : null;
  const input =
    draft.owner === userId && draft.signal === sessionSignal
      ? draft
      : {
          owner: userId,
          signal: sessionSignal,
          search: "",
          assistant: "" as const,
          role: "" as const,
        };
  const messages = current?.messages ?? [];
  const nextBefore = current?.nextBefore ?? null;
  const busy = !current || current.phase === "loading" || current.mutating;
  const error = current?.error ?? "";
  const filters = current?.filters ?? {};
  const filtered = Object.keys(filters).length > 0;
  const selected =
    current && source?.owner === userId && source.signal === sessionSignal
      ? source.message
      : null;
  const apply = (filters: FavoriteMessageFilters) => {
    setSource(null);
    void liveResource()?.filter(filters);
  };
  if (sessionSignal.aborted || current?.phase === "closed") return null;
  return (
    <>
      {selected && (
        <FavoriteMessageContext
          key={userId + ":" + selected.threadId + ":" + selected.id}
          userId={userId}
          source={selected}
          sessionSignal={sessionSignal}
          onAccessDenied={onAccessDenied}
          onOpenConversation={onOpenConversation}
          onBack={() => {
            setSource(null);
            requestAnimationFrame(() => {
              if (sessionSignal.aborted) return;
              sourceButton.current?.focus({ preventScroll: true });
              window.scrollTo({ top: listScroll.current, behavior: "instant" });
            });
          }}
        />
      )}
      <div hidden={selected !== null}>
        <Card
          className="message-favorites"
          aria-label="Избранные сообщения"
          aria-busy={busy}
        >
          <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span>
          <h1>Избранные сообщения</h1>
          <p>Ваши сообщения и ответы помощников — всё важное в одном месте.</p>
          <small>
            Удаляется только закладка. Сообщение остаётся в диалоге.
          </small>
          <form
            className={styles.filters + " ym-hide-content"}
            aria-label="Поиск в избранном"
            onSubmit={(event) => {
              event.preventDefault();
              const search = input.search.trim();
              apply({
                ...(search ? { search } : {}),
                ...(input.assistant ? { assistantKey: input.assistant } : {}),
                ...(input.role ? { role: input.role } : {}),
              });
            }}
          >
            <Field
              label="Поиск по тексту избранного"
              type="search"
              maxLength={160}
              autoComplete="off"
              className="ym-disable-keys"
              value={input.search}
              disabled={current?.mutating}
              onChange={(event) =>
                setDraft({ ...input, search: event.target.value })
              }
            />
            <SelectField
              label="Помощник в избранном"
              value={input.assistant}
              disabled={current?.mutating}
              onChange={(event) =>
                setDraft({
                  ...input,
                  assistant: event.target.value as AgentKey | "",
                })
              }
            >
              <option value="">Все помощники</option>
              {Object.entries(agentNames).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Автор сообщения"
              value={input.role}
              disabled={current?.mutating}
              onChange={(event) =>
                setDraft({
                  ...input,
                  role: event.target.value as "user" | "assistant" | "",
                })
              }
            >
              <option value="">Все сообщения</option>
              <option value="user">Мои сообщения</option>
              <option value="assistant">Ответы помощников</option>
            </SelectField>
            <div className={styles.actions}>
              <Button type="submit" disabled={!current || current.mutating}>
                Найти в избранном
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!current || current.mutating}
                onClick={() => {
                  setDraft({
                    owner: userId,
                    signal: sessionSignal,
                    search: "",
                    assistant: "",
                    role: "",
                  });
                  apply({});
                }}
              >
                Сбросить поиск
              </Button>
            </div>
          </form>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Обновляем избранное…</p>}
          {!busy && !error && !messages.length && !nextBefore && (
            <div className="favorites-empty">
              <h2>{filtered ? "Ничего не найдено" : "Пока здесь пусто"}</h2>
              <p>
                {filtered
                  ? "Измените условия или сбросьте поиск."
                  : "Нажмите «В избранное» под своим сообщением или ответом помощника. Сохранённое появится здесь."}
              </p>
              {!filtered && <Button onClick={onClose}>Открыть диалоги</Button>}
            </div>
          )}
          <div className="favorites-list" hidden={!messages.length}>
            {messages.map((message) => (
              <article
                key={message.id}
                className="conversation-message ym-hide-content"
                aria-label={"Сохранённое сообщение " + message.id}
              >
                <strong>
                  {message.role === "user"
                    ? "Вы"
                    : agentNames[message.agentKey]}
                </strong>
                {message.role === "user" ? (
                  <p>{message.content}</p>
                ) : (
                  <AssistantMessage content={message.content} />
                )}
                {message.status === "interrupted" && (
                  <p>
                    <small>Ответ прерван</small>
                  </p>
                )}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={(event) => {
                    if (!liveResource() || busy) return;
                    sourceButton.current = event.currentTarget;
                    listScroll.current = window.scrollY;
                    setSource({
                      owner: userId,
                      signal: sessionSignal,
                      message,
                    });
                  }}
                >
                  Открыть в диалоге
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void liveResource()?.remove(message.id)}
                >
                  Убрать из избранного
                </Button>
              </article>
            ))}
          </div>
          {nextBefore && (
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() => void liveResource()?.load(nextBefore)}
            >
              Показать ещё
            </Button>
          )}
          {error && (
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() => void liveResource()?.load()}
            >
              Обновить список
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            ← В приложение
          </Button>
        </Card>
      </div>
    </>
  );
}

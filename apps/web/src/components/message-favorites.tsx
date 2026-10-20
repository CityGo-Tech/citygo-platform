"use client";
import { useEffect, useRef, useState } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type { FavoriteMessage } from "@citygo/contracts";
import { AssistantMessage, Button, Card } from "@citygo/ui-web";
import { agentNames } from "./agent-names";

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
      {saved ? "В избранном" : "В избранное"}
    </Button>
  );
}

export function MessageFavoritesPanel({
  userId,
  sessionSignal,
  onClose,
  onAccessDenied,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onClose: () => void;
  onAccessDenied: () => void;
}) {
  const [messages, setMessages] = useState<FavoriteMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const denied = useRef(onAccessDenied);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  const [actions, setActions] = useState<{
    load: (before?: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    let pending = false;
    const api = createClient("/api", { signal: () => signal });
    const active = () => !signal.aborted;
    const failure = (cause: unknown) => {
      if (!active()) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        setMessages([]);
        controller.abort();
        denied.current();
      } else
        setError("Не удалось обновить избранное. Повторите действие позже.");
    };
    const load = async (before?: string) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        const page = await api.favoriteMessages(before);
        if (!active()) return;
        if (page.userId !== userId) throw new Error("Favorite owner mismatch");
        setMessages((current) =>
          before
            ? [
                ...current,
                ...page.messages.filter(
                  (item) => !current.some((old) => old.id === item.id),
                ),
              ]
            : page.messages,
        );
        setNextBefore(page.nextBefore);
      } catch (cause) {
        failure(cause);
      } finally {
        pending = false;
        if (active()) setBusy(false);
      }
    };
    const remove = async (id: string) => {
      if (!active() || pending) return;
      pending = true;
      setBusy(true);
      setError("");
      try {
        await api.setMessageFavorite(id, false);
        if (active())
          setMessages((current) => current.filter((item) => item.id !== id));
      } catch (cause) {
        failure(cause);
      } finally {
        pending = false;
        if (active()) setBusy(false);
      }
    };
    setActions({ load, remove });
    void load();
    return () => controller.abort();
  }, [userId, sessionSignal]);
  if (sessionSignal.aborted) return null;
  return (
    <Card
      className="message-favorites"
      aria-label="Избранные сообщения"
      aria-busy={busy}
    >
      <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span>
      <h1>Избранные сообщения</h1>
      <p>Ваши сообщения и ответы помощников — всё важное в одном месте.</p>
      <small>
        Удаляется только закладка: сообщения остаются в диалогах. Сохранение не
        отправляет текст AI-провайдерам или Bubble.
      </small>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Обновляем избранное…</p>}
      {!busy && !error && !messages.length && !nextBefore && (
        <div className="favorites-empty">
          <h2>Пока здесь пусто</h2>
          <p>
            Нажмите «В избранное» под своим сообщением или ответом помощника.
            Сохранённое появится здесь.
          </p>
          <Button onClick={onClose}>Открыть диалоги</Button>
        </div>
      )}
      <div className="favorites-list" hidden={!messages.length}>
        {messages.map((message) => (
          <article
            key={message.id}
            className="conversation-message"
            aria-label={"Сохранённое сообщение " + message.id}
          >
            <strong>
              {message.role === "user" ? "Вы" : agentNames[message.agentKey]}
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
              variant="ghost"
              disabled={busy}
              onClick={() => void actions?.remove(message.id)}
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
          onClick={() => void actions?.load(nextBefore)}
        >
          Показать ещё
        </Button>
      )}
      {error && (
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() => void actions?.load()}
        >
          Обновить список
        </Button>
      )}
      <Button variant="secondary" onClick={onClose}>
        ← В приложение
      </Button>
    </Card>
  );
}

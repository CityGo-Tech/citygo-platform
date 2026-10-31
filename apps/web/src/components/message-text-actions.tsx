"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@citygo/ui-web";
import {
  createMessageTextActions,
  sameMessageTextScope,
  isMessageTextActionCurrent,
  type MessageTextContext,
  type MessageTextScope,
  type MessageTextView,
} from "./message-text-actions-state";
import styles from "./message-text-actions.module.css";

function downloadMessageText(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
/** Finished message text is copied/exported exactly, never rendered as a file URL or HTML. */
export function MessageTextActions({
  userId,
  threadId,
  messageId,
  text,
  sessionSignal,
  disabled = false,
}: MessageTextScope & { disabled?: boolean }) {
  const scope = useMemo(
    () => ({ userId, threadId, messageId, text, sessionSignal }),
    [userId, threadId, messageId, text, sessionSignal],
  );
  const latest = useRef<MessageTextContext>({ ...scope, enabled: !disabled });
  latest.current = { ...scope, enabled: !disabled };
  const [snapshot, setSnapshot] = useState<{
    scope: MessageTextScope;
    view: MessageTextView;
  } | null>(null);
  const actions = useRef<ReturnType<typeof createMessageTextActions> | null>(
    null,
  );
  const manual = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const resource = createMessageTextActions({
      scope,
      current: () => latest.current,
      publish: (view) => setSnapshot({ scope, view }),
      writeClipboard: (value) => {
        if (!navigator.clipboard?.writeText)
          return Promise.reject(new Error("clipboard-unavailable"));
        return navigator.clipboard.writeText(value);
      },
      download: downloadMessageText,
    });
    actions.current = resource;
    setSnapshot({ scope, view: { phase: "idle" } });
    const abort = () => {
      resource.dispose();
      setSnapshot(null);
    };
    sessionSignal.addEventListener("abort", abort, { once: true });
    return () => {
      resource.dispose();
      sessionSignal.removeEventListener("abort", abort);
      if (actions.current === resource) actions.current = null;
    };
  }, [scope, sessionSignal, disabled]);
  const view =
    snapshot && sameMessageTextScope(snapshot.scope, latest.current)
      ? snapshot.view
      : null;
  useEffect(() => {
    if (view?.phase === "manual" && !disabled && !sessionSignal.aborted) {
      manual.current?.focus();
      manual.current?.select();
    }
  }, [view?.phase, disabled, sessionSignal]);
  if (sessionSignal.aborted) return null;
  const blocked = disabled || !view || view.phase === "copying";
  return (
    <div
      className={styles.container + " ym-hide-content"}
      role="group"
      aria-label="Сохранить текст сообщения"
    >
      <div className={styles.actions}>
        <Button
          type="button"
          variant="ghost"
          disabled={blocked}
          onClick={() => {
            if (isMessageTextActionCurrent(scope, latest.current))
              void actions.current?.copy();
          }}
        >
          {view?.phase === "copying" ? "Копируем…" : "Копировать текст"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={blocked}
          onClick={() => {
            if (isMessageTextActionCurrent(scope, latest.current))
              actions.current?.download();
          }}
        >
          Скачать .txt
        </Button>
      </div>
      <span role="status" className={styles.feedback}>
        {view?.phase === "copied"
          ? "Текст скопирован"
          : view?.phase === "downloaded"
            ? "Файл подготовлен"
            : ""}
      </span>
      {view?.phase === "manual" && (
        <label className={styles.manual}>
          Автоматическое копирование недоступно. Скопируйте выделенный текст.
          <textarea
            ref={manual}
            value={text}
            readOnly
            rows={4}
            className="ym-disable-keys ym-hide-content"
            aria-label="Текст для копирования"
          />
        </label>
      )}
      {view?.phase === "error" && (
        <p role="alert">
          Не удалось подготовить файл. Попробуйте ещё раз или скопируйте текст.
        </p>
      )}
    </div>
  );
}

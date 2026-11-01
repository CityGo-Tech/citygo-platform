"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button } from "@citygo/ui-web";
import {
  createConversationExportAction,
  type ConversationExportState,
} from "./conversation-export-state";
import styles from "./conversation-export.module.css";

/** Explicit private download; no API read on mount, analytics or storage. */
export function ConversationExportAction(props: {
  userId: string;
  threadId: string;
  sessionSignal: AbortSignal;
  disabled: boolean;
  onAccessDenied: () => void;
}) {
  const { userId, threadId, sessionSignal, disabled } = props;
  const latest = useRef(props);
  latest.current = props;
  const resource = useRef<ReturnType<
    typeof createConversationExportAction
  > | null>(null);
  const [state, setState] = useState<{
    userId: string;
    threadId: string;
    signal: AbortSignal;
    value: ConversationExportState;
  } | null>(null);
  useEffect(() => {
    const action = createConversationExportAction({
      scope: { userId, threadId, signal: sessionSignal },
      current: () => ({
        userId: latest.current.userId,
        threadId: latest.current.threadId,
        signal: latest.current.sessionSignal,
        enabled: !latest.current.disabled,
      }),
      read: (signal) =>
        createClient("/api", { signal: () => signal }).exportConversation(
          threadId,
        ),
      publish: (value) =>
        setState({ userId, threadId, signal: sessionSignal, value }),
      onAccessDenied: () => latest.current.onAccessDenied(),
      download: (text, filename) => {
        const url = URL.createObjectURL(
          new Blob([text], { type: "text/plain;charset=utf-8" }),
        );
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          // A detached link avoids inserting a personal filename into recorded
          // DOM/URLs. No content/title enters telemetry or persistent storage.
          link.click();
        } finally {
          URL.revokeObjectURL(url);
        }
      },
    });
    resource.current = action;
    return () => {
      action.dispose();
      if (resource.current === action) resource.current = null;
    };
  }, [userId, threadId, sessionSignal]);
  const value =
    !sessionSignal.aborted &&
    state?.userId === userId &&
    state.threadId === threadId &&
    state.signal === sessionSignal
      ? state.value
      : null;
  return (
    <div
      className={styles.controls + " ym-hide-content ym-disable-keys"}
      aria-label="Скачивание диалога"
    >
      <div className={styles.actions}>
        <Button
          variant="ghost"
          disabled={disabled || sessionSignal.aborted || value?.busy}
          onClick={() => {
            if (!disabled && !sessionSignal.aborted)
              void resource.current?.run();
          }}
        >
          {value?.busy ? "Готовим файл…" : "Скачать весь диалог"}
        </Button>
        {value?.busy && (
          <Button variant="ghost" onClick={() => resource.current?.cancel()}>
            Отменить скачивание
          </Button>
        )}
      </div>
      {value?.error && <p role="alert">{value.error}</p>}
      {value?.started && <p role="status">Скачивание диалога начато.</p>}
    </div>
  );
}

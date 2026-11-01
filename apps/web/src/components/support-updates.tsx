"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button } from "@citygo/ui-web";
import {
  createSupportUpdatesResource,
  type SupportUpdatesState,
} from "./support-updates-state";
import styles from "./human-support.module.css";

/** Figma support_sent 6:73: a quiet continuation of the saved request flow. */
export function SupportUpdatesNotice({
  userId,
  sessionSignal,
  onAccessDenied,
  onOpen,
  disabled = false,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onOpen: (requestId: string) => void;
  disabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    value: SupportUpdatesState;
  } | null>(null);
  const callbacks = useRef({ onAccessDenied });
  callbacks.current = { onAccessDenied };
  const resource = useRef<ReturnType<
    typeof createSupportUpdatesResource
  > | null>(null);
  useEffect(() => {
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = createSupportUpdatesResource({
      userId,
      signal,
      client: createClient("/api", { signal: () => signal }),
      publish: (value) =>
        setSnapshot({ owner: userId, signal: sessionSignal, value }),
      onAccessDenied: () => callbacks.current.onAccessDenied(),
    });
    resource.current = current;
    const refresh = () => {
      void current.load();
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("citygo-support-read", refresh);
    return () => {
      current.dispose();
      controller.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("citygo-support-read", refresh);
      if (resource.current === current) resource.current = null;
    };
  }, [userId, sessionSignal]);
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.value
      : null;
  if (!state || state.closed || (!state.error && !state.page?.unreadReplies))
    return null;
  return (
    <aside
      className={styles.notice + " ym-hide-content ym-disable-keys"}
      data-citygo-private
      aria-label="Новые ответы команды CityGo"
    >
      {state.error ? (
        <p role="status">{state.error}</p>
      ) : (
        <p role="status">
          <strong>
            Новые ответы команды CityGo: {state.page!.unreadReplies}
          </strong>
          <br />
          Обращений с новыми ответами: {state.page!.unreadRequests}
        </p>
      )}
      <div className={styles.actions}>
        {state.page?.requests.map((item) => (
          <Button
            key={item.requestId}
            disabled={disabled}
            variant="secondary"
            onClick={() => onOpen(item.requestId)}
          >
            Открыть обращение №{item.requestId} · новых ответов:{" "}
            {item.unreadReplies}
          </Button>
        ))}
        {state.page?.nextBefore && (
          <Button
            variant="secondary"
            disabled={disabled || state.busy}
            onClick={() => void resource.current?.load(state.page!.nextBefore!)}
          >
            Ещё обращения с ответами
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={state.busy || disabled}
          onClick={() => void resource.current?.load()}
        >
          Обновить новые ответы
        </Button>
      </div>
    </aside>
  );
}

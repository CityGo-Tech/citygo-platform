"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import {
  supportReplyBodySchema,
  type SupportReplyResult,
} from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import {
  createSupportRepliesResource,
  type SupportRepliesState,
} from "./support-replies-state.js";
const styles = {
  replies: "cg-support-replies",
  list: "cg-support-reply-list",
  notice: "cg-support-reply-notice",
  form: "cg-support-reply-form",
  question: "cg-support-reply-question",
  body: "cg-support-reply-body",
  actions: "cg-support-reply-actions",
};

export function SupportReplies({
  viewerId,
  requestId,
  sessionSignal,
  onAccessDenied,
  admin = false,
  revision = 1,
  requestClosed = false,
  onReplied,
}: {
  viewerId: string;
  requestId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  admin?: boolean;
  revision?: number;
  requestClosed?: boolean;
  onReplied?: (r: SupportReplyResult) => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    viewer: string;
    request: string;
    signal: AbortSignal;
    value: SupportRepliesState;
  } | null>(null);
  const resource = useRef<ReturnType<
    typeof createSupportRepliesResource
  > | null>(null);
  const callbacks = useRef({ onAccessDenied, onReplied });
  callbacks.current = { onAccessDenied, onReplied };
  useEffect(() => {
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, sessionSignal]);
    const api = createClient("/api", { signal: () => signal });
    const r = createSupportRepliesResource({
      viewerId,
      requestId,
      signal,
      admin,
      list: (before) =>
        admin
          ? api.adminSupportReplies(requestId, before ? { before } : {})
          : api.supportReplies(requestId, before ? { before } : {}),
      send: admin
        ? (input) => api.replyToSupportRequest(requestId, input)
        : undefined,
      markRead: admin
        ? undefined
        : (throughReplyId) =>
            api.markSupportRepliesRead(requestId, { throughReplyId }),
      onRead: () => window.dispatchEvent(new Event("citygo-support-read")),
      operationId: () => crypto.randomUUID(),
      publish: (value) =>
        setSnapshot({
          viewer: viewerId,
          request: requestId,
          signal: sessionSignal,
          value,
        }),
      onAccessDenied: () => callbacks.current.onAccessDenied(),
      onReplied: (result) => callbacks.current.onReplied?.(result),
    });
    resource.current = r;
    void r.load();
    return () => {
      controller.abort();
      r.dispose();
      if (resource.current === r) resource.current = null;
    };
  }, [viewerId, requestId, sessionSignal, admin]);
  const state =
    !sessionSignal.aborted &&
    snapshot?.viewer === viewerId &&
    snapshot.request === requestId &&
    snapshot.signal === sessionSignal
      ? snapshot.value
      : null;
  if (sessionSignal.aborted || state?.closed) return null;
  return (
    <section
      className={styles.replies + " ym-hide-content ym-disable-keys"}
      data-citygo-private
      aria-label={"Ответы на обращение №" + requestId}
    >
      <h3>Ответы команды CityGo</h3>
      {state?.error && <p role="alert">{state.error}</p>}
      {(!state || state.busy) && !state?.loaded ? (
        <p role="status">Загружаем ответы…</p>
      ) : state?.loaded && !state.busy && state.replies.length === 0 ? (
        <p className={styles.notice}>Ждём ответа владельца.</p>
      ) : null}
      <ul className={styles.list}>
        {state?.replies.map((reply) => (
          <li key={reply.id}>
            <strong>Команда CityGo</strong>
            <p className={styles.body}>{reply.body}</p>
            <time dateTime={reply.createdAt}>
              {new Date(reply.createdAt).toLocaleString("ru-RU")}
            </time>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={!state || state.busy}
          onClick={() => void resource.current?.load()}
        >
          Обновить ответы
        </Button>
        {state?.nextBefore && (
          <Button
            variant="secondary"
            disabled={state.busy}
            onClick={() => void resource.current?.load(state.nextBefore!)}
          >
            Ещё ответы
          </Button>
        )}
      </div>
      {!admin && state?.loaded && state.replies.length > 0 && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={
              state.busy ||
              !!state.nextBefore ||
              (state.readThrough !== null &&
                BigInt(state.readThrough) >= BigInt(state.replies[0]!.id))
            }
            onClick={() => void resource.current?.acknowledgeDisplayed()}
          >
            {state.readThrough !== null &&
            BigInt(state.readThrough) >= BigInt(state.replies[0]!.id)
              ? "Ответы прочитаны"
              : "Отметить ответы прочитанными"}
          </Button>
          {state.nextBefore && (
            <small>
              Загрузите остальные ответы, чтобы отметить всю переписку
              прочитанной.
            </small>
          )}
        </div>
      )}
      {admin && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (
              state &&
              !state.busy &&
              (state.pending ||
                (!requestClosed &&
                  supportReplyBodySchema.safeParse(state.draft).success))
            )
              void resource.current?.send(revision);
          }}
        >
          <label className={styles.question}>
            Ответ пользователю
            <textarea
              className="ym-hide-content ym-disable-keys"
              data-citygo-private
              maxLength={8000}
              value={state?.draft ?? ""}
              disabled={
                !state || state.busy || !!state.pending || requestClosed
              }
              onChange={(e) => resource.current?.edit(e.target.value)}
            />
          </label>
          {requestClosed && (
            <p>Откройте обращение, чтобы написать новый ответ.</p>
          )}
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={
                !state ||
                state.busy ||
                (!state.pending &&
                  (requestClosed ||
                    !supportReplyBodySchema.safeParse(state.draft).success))
              }
            >
              {state?.pending ? "Повторить тот же ответ" : "Сохранить ответ"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!state || state.busy}
              onClick={() => resource.current?.cancel()}
            >
              Сбросить черновик
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

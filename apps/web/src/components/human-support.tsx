"use client";
import { SupportReplies } from "@citygo/admin";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@citygo/api-client";
import {
  supportRequestBodySchema,
  supportRequestBodyLength,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import {
  createHumanSupportResource,
  type SupportState,
} from "./human-support-state";
import styles from "./human-support.module.css";

export function HumanSupportPanel({
  userId,
  sessionSignal,
  onAccessDenied,
  onClose,
  initialRequestId,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onClose: () => void;
  initialRequestId?: string | null;
}) {
  const [draft, setDraft] = useState({
    owner: userId,
    signal: sessionSignal,
    value: "",
  });
  const body =
    draft.owner === userId && draft.signal === sessionSignal ? draft.value : "";
  const setBody = (value: string) =>
    setDraft({ owner: userId, signal: sessionSignal, value });
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    value: SupportState;
  } | null>(null);
  const [replyRequest, setReplyRequest] = useState<string | null>(null);
  const resource = useRef<ReturnType<typeof createHumanSupportResource> | null>(
    null,
  );
  const denied = useRef(onAccessDenied);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  useEffect(() => {
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, sessionSignal]);
    setBody("");
    setReplyRequest(null);
    const current = createHumanSupportResource({
      userId,
      signal,
      client: createClient("/api", { signal: () => signal }),
      operationId: () => crypto.randomUUID(),
      publish: (value) =>
        setSnapshot({ owner: userId, signal: sessionSignal, value }),
      onAccessDenied: () => denied.current(),
    });
    resource.current = current;
    void current.load().then(async () => {
      if (
        initialRequestId &&
        (await current.open(initialRequestId)) &&
        !signal.aborted
      ) {
        setReplyRequest(initialRequestId);
      }
    });
    return () => {
      current.dispose();
      controller.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, sessionSignal, initialRequestId]);
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.value
      : null;
  useEffect(() => {
    if (replyRequest && !sessionSignal.aborted)
      document.getElementById("human-support-thread-" + replyRequest)?.focus();
  }, [replyRequest, userId, sessionSignal]);
  if (sessionSignal.aborted) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      state?.busy ||
      (!state?.pending && !supportRequestBodySchema.safeParse(body).success)
    )
      return;
    void resource.current?.send(body);
  };
  return (
    <Card
      className={styles.panel}
      aria-labelledby="human-support-heading"
      aria-busy={state?.busy}
    >
      <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
      <h1 id="human-support-heading">
        {state?.receipt ? "Обращение сохранено" : "Можно обратиться к человеку"}
      </h1>
      <p className={styles.intro}>
        Оставьте вопрос владельцу CityGo. Обращение бесплатно.
      </p>
      {state?.receipt && (
        <div role="status" className={styles.notice}>
          <strong>Обращение №{state.receipt.id} сохранено</strong>
          <p>
            <time dateTime={state.receipt.createdAt}>
              {new Date(state.receipt.createdAt).toLocaleString("ru-RU")}
            </time>
          </p>
          <p>
            Статус:{" "}
            {state.receipt.status === "closed"
              ? "Закрыто владельцем"
              : "Открыто"}
            .
          </p>
        </div>
      )}
      {state?.error && state.receipt && <p role="alert">{state.error}</p>}
      {state?.receipt ? (
        <div className={styles.actions}>
          <Button
            onClick={() => {
              setBody("");
              resource.current?.compose();
            }}
          >
            Новый вопрос
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Вернуться к диалогу
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <label className={styles.question} htmlFor="human-support-question">
            <strong>Ваш вопрос</strong>
            <textarea
              id="human-support-question"
              className="ym-hide-content ym-disable-keys"
              data-citygo-private
              value={body}
              maxLength={8000}
              required
              disabled={!!state?.busy || !!state?.pending}
              onChange={(e) => setBody(e.target.value)}
              aria-describedby="human-support-hint"
            />
            <small id="human-support-hint">
              От 20 до 4000 символов. Сейчас {supportRequestBodyLength(body)}.
              История диалогов не прикладывается.
            </small>
          </label>
          {state?.error && <p role="alert">{state.error}</p>}
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={
                !state ||
                state.busy ||
                (!state.pending &&
                  !supportRequestBodySchema.safeParse(body).success)
              }
            >
              {state?.pending
                ? "Повторить сохранение того же вопроса"
                : "Отправить обращение"}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Вернуться к диалогу
            </Button>
          </div>
        </form>
      )}
      <section
        aria-labelledby="support-history-heading"
        className="ym-hide-content ym-disable-keys"
        data-citygo-private
      >
        <h2 id="support-history-heading">Мои обращения</h2>
        <Button
          variant="secondary"
          disabled={!state || state.busy}
          onClick={() => void resource.current?.load()}
        >
          Обновить обращения
        </Button>
        {!state?.loaded && (
          <p role="status">
            {state?.busy ? "Загружаем обращения…" : "Список ещё не загружен."}
          </p>
        )}
        {state?.loaded && state.requests.length === 0 && (
          <p>Сохранённых обращений пока нет.</p>
        )}
        <ul className={styles.list}>
          {state?.requests.map((item) => (
            <li
              key={item.id}
              id={"human-support-thread-" + item.id}
              tabIndex={-1}
            >
              <strong>
                Обращение №{item.id} ·{" "}
                {item.status === "closed" ? "Закрыто владельцем" : "Открыто"}
              </strong>
              <p className={styles.body}>{item.body}</p>
              <small>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString("ru-RU")}
                </time>
              </small>
              <Button
                variant="secondary"
                disabled={!!state.busy}
                onClick={() => setReplyRequest(item.id)}
              >
                Ответы на обращение №{item.id}
              </Button>
              {replyRequest === item.id && (
                <SupportReplies
                  key={userId + ":" + item.id}
                  viewerId={userId}
                  requestId={item.id}
                  sessionSignal={sessionSignal}
                  onAccessDenied={onAccessDenied}
                />
              )}
            </li>
          ))}
        </ul>
        {state?.nextBefore && (
          <Button
            variant="secondary"
            disabled={state.busy}
            onClick={() => void resource.current?.load(state.nextBefore!)}
          >
            Ещё обращения
          </Button>
        )}
      </section>
    </Card>
  );
}

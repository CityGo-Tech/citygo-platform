"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card } from "@citygo/ui-web";
import {
  createAssistantContextResource,
  type AssistantContextView,
} from "./assistant-context-state";
import styles from "./assistant-context.module.css";

const household = { solo: "Один человек", couple: "Пара", family: "Семья" };

export function AssistantContextPanel(props: {
  userId: string;
  threadId: string | null;
  draft: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onClose: () => void;
  onCorrect: () => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const resource = useRef<ReturnType<
    typeof createAssistantContextResource
  > | null>(null);
  const [snapshot, setSnapshot] = useState<{
    userId: string;
    threadId: string | null;
    draft: string;
    signal: AbortSignal;
    view: AssistantContextView;
  } | null>(null);
  useEffect(() => {
    const { userId, threadId, draft, sessionSignal } = props;
    const scope = { userId, threadId, draft, signal: sessionSignal };
    const current = createAssistantContextResource({
      scope,
      current: () => ({
        userId: latest.current.userId,
        threadId: latest.current.threadId,
        draft: latest.current.draft,
        signal: latest.current.sessionSignal,
        enabled: true,
      }),
      read: (signal) =>
        createClient("/api", { signal: () => signal }).previewAssistantContext({
          threadId,
          draft,
        }),
      publish: (view) => setSnapshot({ ...scope, view }),
      onAccessDenied: () => latest.current.onAccessDenied(),
    });
    resource.current = current;
    void current.load();
    heading.current?.focus();
    return () => {
      current.dispose();
      if (resource.current === current) resource.current = null;
    };
  }, [props.userId, props.threadId, props.draft, props.sessionSignal]);
  const view =
    !props.sessionSignal.aborted &&
    snapshot?.userId === props.userId &&
    snapshot.threadId === props.threadId &&
    snapshot.signal === props.sessionSignal &&
    snapshot.draft === props.draft
      ? snapshot.view
      : null;
  const value = view?.phase === "ready" ? view.value : null;
  const fields = value
    ? [
        ["Город назначения", value.profile.targetCity],
        [
          "Бюджет в месяц",
          value.profile.monthlyBudget === null
            ? null
            : new Intl.NumberFormat("ru-RU").format(
                value.profile.monthlyBudget,
              ) + " ₽",
        ],
        ["Дата переезда", value.profile.moveTargetDate],
        [
          "Состав семьи",
          value.profile.household ? household[value.profile.household] : null,
        ],
      ]
    : [];
  return (
    <Card className={styles.panel + " ym-hide-content ym-disable-keys"}>
      <span className="eyebrow">ВАШ ПЕРЕЕЗД</span>
      <h1 ref={heading} tabIndex={-1}>
        Что помощники знают
      </h1>
      <p>
        Сведения о переезде и контекст выбранного разговора. Предположения
        помощника не становятся подтверждёнными фактами о вас.
      </p>
      {(!view || view.phase === "loading") && (
        <p role="status">Загружаем контекст…</p>
      )}
      {view?.phase === "error" && (
        <div role="alert">
          <p>{view.message}</p>
          <Button
            variant="secondary"
            onClick={() => void resource.current?.load()}
          >
            Повторить
          </Button>
        </div>
      )}
      {value && (
        <>
          <section className={styles.row} aria-label="Сохранённые сведения">
            <h2>Вы рассказали</h2>
            {fields.some(([, text]) => text !== null) ? (
              <dl>
                {fields
                  .filter(([, text]) => text !== null)
                  .map(([label, text]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
              </dl>
            ) : (
              <p>
                Отдельных сведений о переезде пока нет. Можно начать с любого
                вопроса.
              </p>
            )}
          </section>
          {fields.some(([, text]) => text === null) && (
            <section className={styles.row}>
              <h2>Вы пока не рассказывали</h2>
              <p>
                {fields
                  .filter(([, text]) => text === null)
                  .map(([label]) => label)
                  .join(", ")}
                . Помощник уточнит нужное по ходу разговора.
              </p>
            </section>
          )}
          <section className={styles.row}>
            <h2>Из выбранного разговора</h2>
            {value.messages.length ? (
              <ol className={styles.messages}>
                {value.messages.map((message, index) => (
                  <li key={index}>
                    <strong>
                      {message.role === "user" ? "Вы" : "Помощник"}
                    </strong>
                    <p>{message.content}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p>Завершённых вопросов и ответов пока нет.</p>
            )}
            {!value.draftIncluded && (
              <p className={styles.meta}>
                Следующий вопрос ещё не написан. Контекст уточняется с вашим
                вопросом.
              </p>
            )}
          </section>
        </>
      )}
      <div className={styles.actions}>
        {value && !value.closed && props.threadId && (
          <Button onClick={props.onCorrect}>Исправить в разговоре</Button>
        )}
        <Button variant="secondary" onClick={props.onClose}>
          Вернуться назад
        </Button>
      </div>
    </Card>
  );
}

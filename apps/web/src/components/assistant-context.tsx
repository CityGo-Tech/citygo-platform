"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card } from "@citygo/ui-web";
import type { AiModeId } from "@citygo/contracts";
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
  aiMode?: AiModeId;
  aiModeCatalogId?: string;
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
    aiMode?: AiModeId;
    aiModeCatalogId?: string;
    signal: AbortSignal;
    view: AssistantContextView;
  } | null>(null);
  useEffect(() => {
    const { userId, threadId, draft, sessionSignal, aiMode, aiModeCatalogId } =
      props;
    const scope = {
      userId,
      threadId,
      draft,
      signal: sessionSignal,
      aiMode,
      aiModeCatalogId,
    };
    const current = createAssistantContextResource({
      scope,
      current: () => ({
        userId: latest.current.userId,
        threadId: latest.current.threadId,
        draft: latest.current.draft,
        aiMode: latest.current.aiMode,
        aiModeCatalogId: latest.current.aiModeCatalogId,
        signal: latest.current.sessionSignal,
        enabled: true,
      }),
      read: (signal) =>
        createClient("/api", { signal: () => signal }).previewAssistantContext({
          threadId,
          draft,
          contextVersion: "model_window_memory_v1",
          ...(aiMode && aiModeCatalogId ? { aiMode, aiModeCatalogId } : {}),
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
  }, [
    props.userId,
    props.threadId,
    props.draft,
    props.sessionSignal,
    props.aiMode,
    props.aiModeCatalogId,
  ]);
  const view =
    !props.sessionSignal.aborted &&
    snapshot?.userId === props.userId &&
    snapshot.threadId === props.threadId &&
    snapshot.signal === props.sessionSignal &&
    snapshot.draft === props.draft &&
    snapshot.aiMode === props.aiMode &&
    snapshot.aiModeCatalogId === props.aiModeCatalogId
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
              <h2>Не заполнено в профиле</h2>
              <p>
                {fields
                  .filter(([, text]) => text === null)
                  .map(([label]) => label)
                  .join(", ")}
                . Эти сведения могут быть в переписке.
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
          {value.memory && (
            <section className={styles.row} aria-label="Память диалога">
              <h2>Память диалога</h2>
              <p>
                Фрагменты ваших сообщений из этого разговора. Новые уточнения
                важнее прежних сведений.
              </p>
              {value.memory.fragments.length ? (
                <ol className={styles.messages}>
                  {value.memory.fragments.map((fragment) => (
                    <li key={fragment.messageId + ":" + fragment.start}>
                      <strong>Ваше сообщение №{fragment.messageId}</strong>
                      <p>{fragment.content}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>Сохранённых фрагментов для этого вопроса пока нет.</p>
              )}
              {!value.memory.complete && (
                <p className={styles.meta}>
                  Показаны выбранные фрагменты. Полная переписка сохраняется в
                  диалоге.
                </p>
              )}
              {value.contextBudget?.needsProviderCheck && (
                <p className={styles.meta}>
                  Размер и состав контекста уточняются при отправке сообщения.
                </p>
              )}
            </section>
          )}
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

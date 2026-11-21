"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentKey, Dashboard } from "@citygo/contracts";
import { CHAT_CHARACTER_LIMIT_LABEL, chatTextProblem } from "@citygo/contracts";
import { ChatTextarea } from "./chat-textarea";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";
import { assistantCatalog } from "./assistant-conversations";
import {
  assistantHandoffDraft,
  assistantHandoffTarget,
  currentAssistantHandoffSource,
  type AssistantHandoffInput,
  type AssistantHandoffSource,
} from "./assistant-handoff-state";
import { emptyResumeExperience, reviewedResumeText } from "./resume-experience";
import styles from "./assistant-handoff.module.css";

const resumeInputs = [
  ["goal", "Цель резюме", 160],
  ["employer", "Работодатель", 160],
  ["role", "Должность, которую занимали", 160],
  ["experience", "Что вы делали", 2400],
  ["skills", "Навыки, которыми пользовались", 900],
] as const;

/** Figma 6:30: deliberate preview and choice, never an automatic transfer. */
export function AssistantHandoffDialog({
  source,
  board,
  sessionSignal,
  disabled,
  intent,
  onPrepare,
  onClose,
}: {
  source: AssistantHandoffSource;
  board: Dashboard;
  sessionSignal: AbortSignal;
  disabled: boolean;
  intent?: AssistantHandoffInput["intent"];
  onPrepare: (input: AssistantHandoffInput) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const formId = useId();
  const resume = intent === "resume";
  const sourceFits = chatTextProblem(source.content) === null;
  const [text, setText] = useState(!resume && sourceFits ? source.content : "");
  const [experience, setExperience] = useState(emptyResumeExperience);
  const confirmedText = resume ? reviewedResumeText(experience) : text;
  const [target, setTarget] = useState<AgentKey>(
    resume
      ? "resume-builder"
      : assistantCatalog.find((item) => item.key !== source.assistantKey)!.key,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const current = useRef({
    board,
    sessionSignal,
    disabled,
    onPrepare,
    onClose,
  });
  current.current = { board, sessionSignal, disabled, onPrepare, onClose };
  const active = currentAssistantHandoffSource(
    source,
    board,
    sessionSignal,
    intent,
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus();
    const aborted = () => current.current.onClose();
    source.sessionSignal.addEventListener("abort", aborted, { once: true });
    return () => {
      source.sessionSignal.removeEventListener("abort", aborted);
      element?.close();
    };
  }, [source]);
  if (!active) return null;
  const close = () => {
    if (!lock.current) current.current.onClose();
  };
  const prepare = async () => {
    const latest = current.current;
    if (
      lock.current ||
      latest.disabled ||
      !currentAssistantHandoffSource(
        source,
        latest.board,
        latest.sessionSignal,
        intent,
      ) ||
      !assistantHandoffTarget(source, target, intent) ||
      confirmedText === null
    )
      return;
    try {
      assistantHandoffDraft(confirmedText);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    lock.current = true;
    setPending(true);
    setError("");
    try {
      const prepared = await latest.onPrepare({
        source,
        target,
        text: confirmedText,
        intent,
      });
      const now = current.current;
      if (
        source.sessionSignal.aborted ||
        now.sessionSignal !== source.sessionSignal
      )
        return;
      if (prepared) now.onClose();
      else if (
        currentAssistantHandoffSource(
          source,
          now.board,
          now.sessionSignal,
          intent,
        )
      )
        setError(
          "Не удалось подготовить разговор. Текст сохранён в этой форме. Повторите действие или вернитесь к разговору.",
        );
    } catch {
      const now = current.current;
      if (
        currentAssistantHandoffSource(
          source,
          now.board,
          now.sessionSignal,
          intent,
        )
      )
        setError(
          "Не удалось подготовить разговор. Проверьте связь и повторите действие.",
        );
    } finally {
      lock.current = false;
      if (
        !source.sessionSignal.aborted &&
        current.current.sessionSignal === source.sessionSignal
      )
        setPending(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      aria-labelledby={formId + "-title"}
      className={styles.dialog + " ym-hide-content"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <Card className={styles.card}>
        <span className={styles.eyebrow}>ПРОДОЛЖИТЬ С ДРУГИМ ПОМОЩНИКОМ</span>
        <h2 id={formId + "-title"} ref={heading} tabIndex={-1}>
          {resume ? "Передача помощнику по резюме" : "Передадим только нужное"}
        </h2>
        {resume ? (
          <>
            <p>
              Укажите свой опыт. Достаточно одной задачи. Остальные поля можно
              оставить пустыми.
            </p>
            <details className={styles.context}>
              <summary>Исходное сообщение</summary>
              <p className={styles.sourceText}>{source.content}</p>
            </details>
            <fieldset className={styles.context}>
              <legend>Что передаём</legend>
              {resumeInputs.map(([key, label, maxLength]) =>
                key === "experience" || key === "skills" ? (
                  <div key={key}>
                    <label htmlFor={formId + "-" + key}>{label}</label>
                    <textarea
                      id={formId + "-" + key}
                      className="ym-disable-keys"
                      value={experience[key]}
                      maxLength={maxLength}
                      rows={key === "experience" ? 4 : 2}
                      disabled={pending || disabled}
                      onChange={(event) => {
                        setExperience({
                          ...experience,
                          [key]: event.target.value,
                        });
                        setError("");
                      }}
                    />
                  </div>
                ) : (
                  <Field
                    key={key}
                    label={label}
                    className="ym-disable-keys"
                    value={experience[key]}
                    maxLength={maxLength}
                    disabled={pending || disabled}
                    onChange={(event) => {
                      setExperience({
                        ...experience,
                        [key]: event.target.value,
                      });
                      setError("");
                    }}
                  />
                ),
              )}
            </fieldset>
          </>
        ) : (
          <>
            <p>
              Выберите помощника и проверьте фрагмент. Он добавится в его
              черновик; отправите сообщение отдельно.
            </p>
            <SelectField
              label="Кому передать фрагмент"
              value={target}
              disabled={pending || disabled}
              onChange={(event) => {
                if (assistantHandoffTarget(source, event.target.value))
                  setTarget(event.target.value);
              }}
            >
              {assistantCatalog
                .filter((item) => item.key !== source.assistantKey)
                .map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.title}
                  </option>
                ))}
            </SelectField>
            <div className={styles.context}>
              <label htmlFor="assistant-handoff-text">Что передаём</label>
              {!sourceFits && (
                <p>
                  Сообщение длиннее {CHAT_CHARACTER_LIMIT_LABEL} символов.
                  Вставьте сюда только нужный фрагмент.
                </p>
              )}
              <ChatTextarea
                id="assistant-handoff-text"
                className="ym-hide-content ym-disable-keys"
                value={text}
                rows={7}
                disabled={pending || disabled}
                onChange={(event) => {
                  setText(event.target.value);
                  setError("");
                }}
                aria-describedby="assistant-handoff-hint"
              />
              <small id="assistant-handoff-hint">
                Остальная переписка остаётся в исходном разговоре. Ваши
                черновики сохраняются.
              </small>
            </div>
          </>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <Button
            type="button"
            disabled={
              pending ||
              disabled ||
              !confirmedText?.trim() ||
              chatTextProblem(confirmedText) !== null
            }
            onClick={() => void prepare()}
          >
            {pending
              ? "Готовим разговор…"
              : resume
                ? "Перейти к помощнику по резюме"
                : "Подготовить разговор"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={close}
          >
            Остаться в разговоре
          </Button>
        </div>
      </Card>
    </dialog>
  );
}

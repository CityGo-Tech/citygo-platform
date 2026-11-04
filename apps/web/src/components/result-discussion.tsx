"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import type {
  AgentKey,
  ResultDiscussionParams,
  ResultDiscussionSource,
} from "@citygo/contracts";
import { CHAT_CHARACTER_LIMIT_LABEL, chatTextProblem } from "@citygo/contracts";
import { ChatTextarea } from "./chat-textarea";
import { Button, Card, SelectField } from "@citygo/ui-web";
import { assistantCatalog } from "./assistant-conversations";
import {
  createResultDiscussionResource,
  initialResultDiscussionDraft,
  resultDiscussionDraft,
  type ResultDiscussionInput,
  type ResultDiscussionState,
} from "./result-discussion-state";
import styles from "./assistant-handoff.module.css";
import resultStyles from "./result-discussion.module.css";

/** Figma 6:28: explicit discussion of the chosen saved result. */
export function ResultDiscussionDialog({
  owner,
  selection,
  sessionSignal,
  disabled,
  onPrepare,
  onAccessDenied,
  onClose,
}: {
  owner: string;
  selection: ResultDiscussionParams;
  sessionSignal: AbortSignal;
  disabled: boolean;
  onPrepare: (input: ResultDiscussionInput) => Promise<boolean>;
  onAccessDenied: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const resource = useRef<ReturnType<
    typeof createResultDiscussionResource
  > | null>(null);
  const initialized = useRef(false);
  const locked = useRef(false);
  const [state, setState] = useState<ResultDiscussionState | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<AgentKey>("support");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef({ onPrepare, onAccessDenied, onClose, disabled });
  latest.current = { onPrepare, onAccessDenied, onClose, disabled };
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus();
    let mounted = true;
    const value = createResultDiscussionResource({
      owner,
      selection,
      sessionSignal,
      read: (signal) =>
        createClient("/api", { signal: () => signal }).resultDiscussionSource(
          selection,
        ),
      publish: (next) => {
        if (!mounted) return;
        setState(next);
        if (next.source && !initialized.current) {
          initialized.current = true;
          setText(initialResultDiscussionDraft(next.source));
          setTarget(next.source.assistantKey);
        }
      },
      onAccessDenied: () => latest.current.onAccessDenied(),
    });
    resource.current = value;
    void value.load();
    const aborted = () => latest.current.onClose();
    sessionSignal.addEventListener("abort", aborted, { once: true });
    return () => {
      mounted = false;
      value.dispose();
      element?.close();
      sessionSignal.removeEventListener("abort", aborted);
      if (resource.current === value) resource.current = null;
    };
  }, [owner, selection, sessionSignal]);
  const close = () => {
    if (!locked.current) latest.current.onClose();
  };
  async function prepare() {
    if (
      locked.current ||
      latest.current.disabled ||
      sessionSignal.aborted ||
      state?.phase !== "ready"
    )
      return;
    try {
      resultDiscussionDraft(text);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    locked.current = true;
    setPending(true);
    setError("");
    try {
      const source: ResultDiscussionSource | null =
        (await resource.current?.confirm()) ?? null;
      if (!source || sessionSignal.aborted) return;
      const prepared = await latest.current.onPrepare({
        source,
        sessionSignal,
        target,
        text,
      });
      if (sessionSignal.aborted) return;
      if (prepared) latest.current.onClose();
      else
        setError(
          "Не удалось открыть разговор. Текст остался в этой форме. Проверьте черновик выбранного помощника и повторите.",
        );
    } catch {
      if (!sessionSignal.aborted)
        setError(
          "Не удалось подготовить черновик. Проверьте связь и повторите.",
        );
    } finally {
      locked.current = false;
      if (!sessionSignal.aborted) setPending(false);
    }
  }
  if (sessionSignal.aborted || state?.phase === "closed") return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="result-discussion-title"
      className={styles.dialog + " ym-hide-content"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <Card className={styles.card}>
        <span className={styles.eyebrow}>СОХРАНЁННЫЙ РЕЗУЛЬТАТ</span>
        <h2 id="result-discussion-title" ref={heading} tabIndex={-1}>
          Обсудить с помощником
        </h2>
        <p>
          Проверьте текст. Он добавится в черновик; отправите сообщение
          отдельно.
        </p>
        {state?.phase === "loading" && (
          <p role="status">Загружаем результат…</p>
        )}
        {state?.source && (
          <>
            <details className={styles.context} open>
              <summary>Полный сохранённый текст</summary>
              <div
                className={resultStyles.source}
                role="region"
                aria-label="Исходный текст результата"
                tabIndex={0}
              >
                {state.source.text}
              </div>
              {state.source.interrupted && (
                <small>Исходный ответ был прерван.</small>
              )}
            </details>
            <SelectField
              label="С кем обсудить"
              value={target}
              disabled={pending || disabled}
              onChange={(event) => setTarget(event.target.value as AgentKey)}
            >
              {assistantCatalog.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.title}
                </option>
              ))}
            </SelectField>
            <div className={styles.context}>
              <label htmlFor="result-discussion-text">
                Текст для обсуждения
              </label>
              {!initialResultDiscussionDraft(state.source) && (
                <p>
                  Результат длиннее {CHAT_CHARACTER_LIMIT_LABEL} символов.
                  Вставьте только нужный фрагмент.
                </p>
              )}
              <ChatTextarea
                id="result-discussion-text"
                className="ym-hide-content ym-disable-keys"
                rows={7}
                value={text}
                disabled={pending || disabled}
                onChange={(event) => {
                  setText(event.target.value);
                  setError("");
                }}
              />
            </div>
          </>
        )}
        {(error || state?.error) && (
          <p className={styles.error} role="alert">
            {error || state?.error}
          </p>
        )}
        <div className={styles.actions}>
          {state?.phase === "error" ? (
            <Button
              disabled={pending || disabled}
              onClick={() => void resource.current?.load()}
            >
              Повторить проверку
            </Button>
          ) : (
            <Button
              disabled={
                pending ||
                disabled ||
                state?.phase !== "ready" ||
                !text.trim() ||
                chatTextProblem(text) !== null
              }
              onClick={() => void prepare()}
            >
              {pending ? "Готовим черновик…" : "Добавить в черновик"}
            </Button>
          )}
          <Button variant="secondary" disabled={pending} onClick={close}>
            Вернуться к результатам
          </Button>
        </div>
      </Card>
    </dialog>
  );
}

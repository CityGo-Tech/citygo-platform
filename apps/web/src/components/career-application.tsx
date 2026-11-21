"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card, Field, SelectField } from "@citygo/ui-web";
import {
  applicationComparison,
  applicationDraft,
  MAX_VACANCY_REQUIREMENTS,
  resumeEvidence,
  vacancyRequirements,
} from "./career-application-state";
import {
  createResultDiscussionResource,
  type ResultDiscussionState,
} from "./result-discussion-state";
import dialogStyles from "./assistant-handoff.module.css";
import styles from "./career-application.module.css";

export function CareerApplicationDialog({
  owner,
  itemId,
  revision,
  details,
  sessionSignal,
  onAccessDenied,
  onClose,
}: {
  owner: string;
  itemId: string;
  revision: number;
  details: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onClose: (refresh?: boolean) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const draftField = useRef<HTMLTextAreaElement>(null);
  const resource = useRef<ReturnType<
    typeof createResultDiscussionResource
  > | null>(null);
  const callbacks = useRef({ onAccessDenied, onClose });
  callbacks.current = { onAccessDenied, onClose };
  const [state, setState] = useState<ResultDiscussionState | null>(null);
  const [vacancy, setVacancy] = useState("");
  const [requirementText, setRequirementText] = useState("");
  const [choices, setChoices] = useState(() => new Map<string, string>());
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [copyError, setCopyError] = useState("");
  const locked = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    heading.current?.focus();
    const selection = { kind: "plan", id: itemId } as const;
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
        if (mounted) setState(next);
      },
      onAccessDenied: () => callbacks.current.onAccessDenied(),
    });
    resource.current = value;
    const close = () => callbacks.current.onClose();
    sessionSignal.addEventListener("abort", close, { once: true });
    void value.load();
    return () => {
      mounted = false;
      value.dispose();
      resource.current = null;
      sessionSignal.removeEventListener("abort", close);
      element?.close();
    };
  }, [itemId, owner, sessionSignal]);

  const evidence = resumeEvidence(details);
  const requirements = vacancyRequirements(requirementText);
  const comparison = applicationComparison(requirements, evidence, choices);
  const tooMany = requirements.length > MAX_VACANCY_REQUIREMENTS;
  const prepared = applicationDraft(vacancy, comparison.supported);
  const current = state?.source?.revision === revision;
  const changed = state?.source != null && !current;
  const busy = state?.checking === true;

  function updateRequirements(value: string) {
    setRequirementText(value);
    const kept = new Set(vacancyRequirements(value));
    setChoices(
      (previous) =>
        new Map([...previous].filter(([requirement]) => kept.has(requirement))),
    );
  }

  function close() {
    const value = resource.current;
    resource.current = null;
    value?.dispose();
    onClose(changed);
  }

  async function verifiedAction(action: () => void | Promise<void>) {
    const value = resource.current;
    if (!value || locked.current || sessionSignal.aborted || !current) return;
    locked.current = true;
    setNotice("");
    setCopyError("");
    try {
      const verified = await value.confirm();
      if (
        resource.current === value &&
        verified?.revision === revision &&
        !sessionSignal.aborted
      )
        await action();
    } finally {
      locked.current = false;
    }
  }

  function showDraft() {
    if (!prepared || tooMany) return;
    void verifiedAction(() => {
      setDraft(prepared);
      requestAnimationFrame(() => draftField.current?.focus());
    });
  }

  function copyDraft() {
    const text = draft;
    if (!text?.trim()) return;
    void verifiedAction(async () => {
      try {
        await navigator.clipboard.writeText(text);
        if (!sessionSignal.aborted) setNotice("Отклик скопирован.");
      } catch {
        if (!sessionSignal.aborted)
          setCopyError(
            "Не удалось скопировать. Выделите и скопируйте текст вручную.",
          );
      }
    });
  }

  if (sessionSignal.aborted || state?.phase === "closed") return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={id + "-title"}
      className={dialogStyles.dialog + " ym-hide-content"}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <Card className={dialogStyles.card}>
        <h2 id={id + "-title"} ref={heading} tabIndex={-1}>
          Подготовьте один честный отклик
        </h2>
        {(!state || state.phase === "loading") && (
          <p role="status">Проверяем сохранённое резюме…</p>
        )}
        {changed ? (
          <p role="alert" className={dialogStyles.error}>
            Резюме изменилось. Откройте сохранённый результат заново.
          </p>
        ) : state?.error ? (
          <p role="alert" className={dialogStyles.error}>
            {state.error}
          </p>
        ) : null}
        {state?.phase === "error" && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => void resource.current?.load()}
          >
            Повторить проверку
          </Button>
        )}
        {current && draft === null && (
          <>
            <p>
              Добавьте требования выбранной вакансии и отметьте, какой опыт их
              подтверждает.
            </p>
            <Field
              label="Название вакансии"
              className="ym-disable-keys"
              value={vacancy}
              maxLength={120}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setVacancy(event.target.value)}
            />
            <label className={dialogStyles.context}>
              <span id={id + "-requirements"}>Требования вакансии</span>
              <textarea
                className="ym-disable-keys"
                aria-labelledby={id + "-requirements"}
                aria-describedby={id + "-requirements-hint"}
                value={requirementText}
                maxLength={1800}
                rows={3}
                disabled={busy}
                onChange={(event) => updateRequirements(event.target.value)}
              />
              <small id={id + "-requirements-hint"}>
                По одному требованию на строку, до {MAX_VACANCY_REQUIREMENTS}.
              </small>
            </label>
            {tooMany && (
              <p role="alert" className={dialogStyles.error}>
                Оставьте до {MAX_VACANCY_REQUIREMENTS} требований.
              </p>
            )}
            {!tooMany && requirements.length > 0 && (
              <fieldset className={styles.matches}>
                <legend>Подтверждённый опыт</legend>
                <details className={styles.source}>
                  <summary>Текст сохранённого резюме</summary>
                  <p>{details}</p>
                </details>
                {requirements.map((requirement) => (
                  <SelectField
                    key={requirement}
                    label={requirement}
                    className={styles.choice}
                    value={choices.get(requirement) ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      const fact = event.target.value;
                      setChoices((previous) =>
                        new Map(previous).set(requirement, fact),
                      );
                    }}
                  >
                    <option value="">Нужно уточнить</option>
                    {evidence.map((fact) => (
                      <option key={fact} value={fact}>
                        {fact}
                      </option>
                    ))}
                  </SelectField>
                ))}
              </fieldset>
            )}
          </>
        )}
        {current && !tooMany && comparison.missing.length > 0 && (
          <section className={styles.missing} aria-labelledby={id + "-missing"}>
            <h3 id={id + "-missing"}>Что нужно уточнить</h3>
            <ul>
              {comparison.missing.map((requirement) => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
          </section>
        )}
        {current && draft !== null && (
          <label className={dialogStyles.context}>
            <span id={id + "-draft"}>Текст отклика</span>
            <textarea
              ref={draftField}
              className="ym-disable-keys"
              aria-labelledby={id + "-draft"}
              value={draft}
              maxLength={6000}
              rows={7}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice("");
              }}
            />
          </label>
        )}
        {notice && <p role="status">{notice}</p>}
        {copyError && (
          <p role="alert" className={dialogStyles.error}>
            {copyError}
          </p>
        )}
        <div className={dialogStyles.actions}>
          {current &&
            (draft === null ? (
              <Button
                type="button"
                disabled={busy || tooMany || !prepared}
                onClick={showDraft}
              >
                Проверить отклик
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={copyDraft}
                >
                  Скопировать отклик
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setNotice("");
                    setCopyError("");
                    heading.current?.focus();
                  }}
                >
                  Вернуться к сравнению
                </Button>
              </>
            ))}
          <Button type="button" variant="ghost" onClick={close}>
            Закрыть
          </Button>
        </div>
      </Card>
    </dialog>
  );
}

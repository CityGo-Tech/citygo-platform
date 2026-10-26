"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import { aiModeLabels, type AiModeId } from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import {
  createAiModeConsentResource,
  type AiModeConsentView,
} from "./ai-mode-consent-state";
import styles from "./ai-mode-consent.module.css";

export function AiModeConsentDialog({
  userId,
  mode,
  sessionSignal,
  onClose,
  onConfirmed,
  onBaseConsentRequired,
  onAccessDenied,
  verifyOwner,
}: {
  userId: string;
  mode: AiModeId;
  sessionSignal: AbortSignal;
  onClose: () => void;
  onConfirmed: (mode: AiModeId) => Promise<void>;
  onBaseConsentRequired: () => Promise<void>;
  onAccessDenied: () => void;
  verifyOwner: (signal: AbortSignal) => Promise<boolean>;
}) {
  const [view, setView] = useState<AiModeConsentView>({ phase: "closed" });
  const [checked, setChecked] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const callbacks = useRef({
    onConfirmed,
    onBaseConsentRequired,
    onAccessDenied,
    verifyOwner,
  });
  callbacks.current = {
    onConfirmed,
    onBaseConsentRequired,
    onAccessDenied,
    verifyOwner,
  };
  const resource = useRef<ReturnType<
    typeof createAiModeConsentResource
  > | null>(null);
  useEffect(() => {
    setChecked(false);
    // Selection, cancellation and account changes own a separate abort lifetime.
    const api = (signal: AbortSignal) =>
      createClient("/api", { signal: () => signal });
    const current = createAiModeConsentResource({
      userId,
      sessionSignal,
      load: (signal) => api(signal).accountConsents(),
      save: (choice, signal) => api(signal).confirmAiModesConsent(choice),
      verifyOwner: (signal) => callbacks.current.verifyOwner(signal),
      onConfirmed: (selected) => callbacks.current.onConfirmed(selected),
      onBaseConsentRequired: () => callbacks.current.onBaseConsentRequired(),
      onAccessDenied: () => callbacks.current.onAccessDenied(),
      publish: setView,
    });
    resource.current = current;
    void current.open(mode);
    return () => {
      if (resource.current === current) resource.current = null;
      current.dispose();
    };
  }, [sessionSignal, userId, mode]);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  function close() {
    resource.current?.cancel();
    onClose();
  }
  const consent =
    view.phase === "ready" || view.phase === "saving" ? view.consent : null;
  const saving = view.phase === "saving";
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="ai-mode-consent-title"
      aria-describedby="ai-mode-consent-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2 id="ai-mode-consent-title">Новые режимы ответа</h2>
      <p id="ai-mode-consent-description">
        Для первого выбора режима «{aiModeLabels[mode]}» подтвердите обновлённые
        условия обработки данных.
      </p>
      {view.phase === "closed" || view.phase === "loading" ? (
        <p role="status">Загружаем условия…</p>
      ) : view.phase === "error" ? (
        <>
          <p role="alert">{view.message}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setChecked(false);
              void resource.current?.open(mode);
            }}
          >
            Загрузить условия
          </Button>
        </>
      ) : null}
      {consent && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void resource.current?.confirm(checked);
          }}
        >
          <p>
            <a
              href={consent.policy.personalData.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Условия обработки персональных данных
            </a>
          </p>
          <details className={styles.details}>
            <summary>Прочитать условия здесь</summary>
            <article aria-label={consent.policy.personalData.label}>
              <p className={styles.version}>
                Редакция {consent.policy.version}
              </p>
              {consent.policy.personalData.text
                .split("\n\n")
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
            </article>
          </details>
          <label className={styles.choice}>
            <input
              type="checkbox"
              name="aiModesPersonalDataConsent"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
              disabled={saving}
              required
            />
            <span>{consent.policy.personalData.label}</span>
          </label>
          <Button type="submit" disabled={saving || !checked}>
            {saving ? "Сохраняем…" : "Подтвердить и выбрать"}
          </Button>
        </form>
      )}
      <Button variant="ghost" onClick={close}>
        Отмена
      </Button>
    </dialog>
  );
}

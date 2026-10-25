"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createClient } from "@citygo/api-client";
import type {
  ServiceConsentChoice,
  ServiceConsentPolicy,
  ServiceConsentState,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import styles from "./service-consents.module.css";

export function ConsentChoices({
  policy,
  personalData,
  marketing,
  disabled,
  onPersonalData,
  onMarketing,
}: {
  policy: ServiceConsentPolicy;
  personalData: boolean;
  marketing: boolean;
  disabled: boolean;
  onPersonalData: (value: boolean) => void;
  onMarketing: (value: boolean) => void;
}) {
  return (
    <fieldset className={styles.choices} disabled={disabled}>
      <legend>Условия работы</legend>
      {(["personalData", "marketing"] as const).map((purpose) => {
        const document = policy[purpose];
        const required = purpose === "personalData";
        return (
          <div key={purpose} className={styles.choice}>
            <label>
              <input
                type="checkbox"
                name={required ? "personalDataConsent" : "marketingConsent"}
                aria-label={document.label}
                checked={required ? personalData : marketing}
                onChange={(event) =>
                  (required ? onPersonalData : onMarketing)(
                    event.target.checked,
                  )
                }
                required={required}
              />
              <span>
                {document.label}
                {required && <span aria-hidden="true"> *</span>}
              </span>
            </label>
            <details
              key={policy.version + ":" + purpose}
              className={styles.document}
            >
              <summary>
                Читать согласие{" "}
                {required ? "на обработку данных" : "на рассылку"}
              </summary>
              <article aria-label={document.label}>
                <p className={styles.version}>Редакция {policy.version}</p>
                {document.text.split("\n\n").map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </article>
            </details>
          </div>
        );
      })}
      <small>
        * Обязательно для регистрации и работы сервиса. Рассылка добровольная.
      </small>
    </fieldset>
  );
}

/** A one-time required acceptance gate, never an account settings destination. */
export function ServiceConsentsPanel({
  sessionSignal,
  onAccessDenied,
  onSaved,
}: {
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onSaved: () => Promise<void>;
}) {
  const [state, setState] = useState<ServiceConsentState | null>(null);
  const [personalData, setPersonalData] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false);
  const denied = useRef(onAccessDenied);
  denied.current = onAccessDenied;
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => sessionSignal,
        onUnauthorized: () => denied.current(),
      }),
    [sessionSignal],
  );
  useEffect(() => {
    let active = true;
    setState(null);
    setPersonalData(false);
    setMarketing(false);
    setError("");
    void api
      .accountConsents()
      .then((next) => {
        if (active && !sessionSignal.aborted) setState(next);
      })
      .catch((cause: unknown) => {
        if (active && !sessionSignal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Не удалось загрузить условия.",
          );
      });
    return () => {
      active = false;
    };
  }, [api, sessionSignal, revision]);
  async function save() {
    if (
      !state ||
      !personalData ||
      busy ||
      submitting.current ||
      sessionSignal.aborted
    )
      return;
    const choice: ServiceConsentChoice = {
      policyVersion: state.policy.version,
      personalData: true,
      marketing,
    };
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await api.setAccountConsents(choice);
      if (!sessionSignal.aborted) await onSaved();
    } catch (cause) {
      if (!sessionSignal.aborted) {
        if (cause instanceof ApiError && cause.status === 409) {
          // Fresh snapshots always require a fresh explicit checkbox choice.
          setState(null);
          setPersonalData(false);
          setMarketing(false);
          setRevision((value) => value + 1);
        } else {
          setError(
            cause instanceof Error
              ? cause.message
              : "Не удалось сохранить выбор.",
          );
        }
      }
    } finally {
      submitting.current = false;
      if (!sessionSignal.aborted) setBusy(false);
    }
  }
  return (
    <Card className={styles.panel} aria-labelledby="service-consents-heading">
      <h1 id="service-consents-heading">Согласие для работы сервиса</h1>
      <p>
        Обновились условия CityGo. Прочитайте их и подтвердите выбор, чтобы
        продолжить.
      </p>
      {error && <p role="alert">{error}</p>}
      {state ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <ConsentChoices
            policy={state.policy}
            personalData={personalData}
            marketing={marketing}
            disabled={busy}
            onPersonalData={setPersonalData}
            onMarketing={setMarketing}
          />
          <Button type="submit" disabled={busy || !personalData}>
            {busy ? "Сохраняем…" : "Принять и продолжить"}
          </Button>
        </form>
      ) : (
        !error && <p role="status">Загружаем условия…</p>
      )}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => setRevision((value) => value + 1)}
      >
        Обновить условия
      </Button>
    </Card>
  );
}

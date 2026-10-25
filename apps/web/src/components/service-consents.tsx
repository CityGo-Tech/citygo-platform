"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
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
      <legend>Согласия</legend>
      <label>
        <input
          type="checkbox"
          name="personalDataConsent"
          aria-label={policy.personalData.label}
          checked={personalData}
          onChange={(event) => onPersonalData(event.target.checked)}
          required
        />
        <span>
          {policy.personalData.label} <span aria-hidden="true">*</span>{" "}
          <a
            href={policy.personalData.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Читать согласие
          </a>
        </span>
      </label>
      <label>
        <input
          type="checkbox"
          name="marketingConsent"
          aria-label={policy.marketing.label}
          checked={marketing}
          onChange={(event) => onMarketing(event.target.checked)}
        />
        <span>
          {policy.marketing.label}{" "}
          <a
            href={policy.marketing.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Читать согласие
          </a>
        </span>
      </label>
      <small>* Обязательно для регистрации и работы сервиса.</small>
    </fieldset>
  );
}

export function ServiceConsentsPanel({
  sessionSignal,
  onAccessDenied,
  onSaved,
  onClose,
  required,
}: {
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onSaved: () => Promise<void>;
  onClose?: () => void;
  required: boolean;
}) {
  const [state, setState] = useState<ServiceConsentState | null>(null);
  const [personalData, setPersonalData] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
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
        if (!active || sessionSignal.aborted) return;
        setState(next);
        // An existing-account gate always requires a fresh explicit choice.
        if (!required) {
          setPersonalData(next.personalDataGranted);
          setMarketing(next.marketingGranted);
        }
      })
      .catch((error: unknown) => {
        if (active && !sessionSignal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Не удалось загрузить согласия.",
          );
      });
    return () => {
      active = false;
    };
  }, [api, sessionSignal, revision, required]);
  async function save() {
    if (!state || !personalData || busy || sessionSignal.aborted) return;
    const choice: ServiceConsentChoice = {
      policyVersion: state.policy.version,
      personalData: true,
      marketing,
    };
    setBusy(true);
    setError("");
    try {
      await api.setAccountConsents(choice);
      if (!sessionSignal.aborted) await onSaved();
    } catch (error) {
      if (!sessionSignal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось сохранить согласия.",
        );
    } finally {
      if (!sessionSignal.aborted) setBusy(false);
    }
  }
  return (
    <Card className={styles.panel} aria-labelledby="service-consents-heading">
      <h1 id="service-consents-heading">
        {required ? "Согласие для работы сервиса" : "Ваши согласия"}
      </h1>
      {required && (
        <p>Для продолжения нужно согласие на обработку персональных данных.</p>
      )}
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
            {busy
              ? "Сохраняем…"
              : required
                ? "Продолжить"
                : "Сохранить согласия"}
          </Button>
        </form>
      ) : (
        !error && <p role="status">Загружаем согласия…</p>
      )}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => setRevision((value) => value + 1)}
      >
        Обновить согласия
      </Button>
      {onClose && (
        <Button variant="ghost" onClick={onClose}>
          Назад
        </Button>
      )}
    </Card>
  );
}

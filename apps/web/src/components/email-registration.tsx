"use client";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@citygo/api-client";
import type {
  RegistrationPolicyResponse,
  ServiceConsentChoice,
} from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import { ConsentChoices } from "./service-consents";
import {
  isEmailRegistrationCode,
  registrationClock,
  type PendingEmailRegistration,
} from "./email-registration-state";
import styles from "./email-registration.module.css";

/** Figma 6:8 / 6:9, using real confirmation rather than the prototype demo. */
export function EmailRegistration({
  pending,
  busy,
  disabled,
  formVersion,
  sessionSignal,
  onRegister,
  onConfirm,
  onResend,
  onBack,
}: {
  pending: PendingEmailRegistration | null;
  busy: boolean;
  disabled: boolean;
  formVersion: number;
  sessionSignal: AbortSignal;
  onRegister: (
    event: FormEvent<HTMLFormElement>,
    consents: ServiceConsentChoice,
  ) => void;
  onConfirm: (code: string) => void;
  onResend: () => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [now, setNow] = useState(Date.now);
  const [policy, setPolicy] = useState<RegistrationPolicyResponse | null>(null);
  const [policyError, setPolicyError] = useState("");
  const [policyRevision, setPolicyRevision] = useState(0);
  const [personalData, setPersonalData] = useState(false);
  const [marketing, setMarketing] = useState(false);
  useEffect(() => {
    if (pending) return;
    let active = true;
    setPolicy(null);
    setPolicyError("");
    setPersonalData(false);
    setMarketing(false);
    void createClient("/api", { signal: () => sessionSignal })
      .registrationPolicy()
      .then((value) => {
        if (active && !sessionSignal.aborted) setPolicy(value);
      })
      .catch((error: unknown) => {
        if (active && !sessionSignal.aborted)
          setPolicyError(
            error instanceof Error
              ? error.message
              : "Не удалось загрузить согласия.",
          );
      });
    return () => {
      active = false;
    };
  }, [pending, policyRevision, sessionSignal]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  const clock = pending ? registrationClock(pending, now) : null;
  return (
    <div className={styles.workspace}>
      <Card className={styles.card} aria-labelledby="registration-heading">
        <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
        <h1 id="registration-heading">
          {pending ? "Проверьте почту" : "Сохраните свой путь"}
        </h1>
        {pending ? (
          <>
            <p>Введите шестизначный код из письма, чтобы создать аккаунт.</p>
            <div className={styles.notice}>
              <strong>Код подтверждения</strong>
              <p>
                Письмо отправлено на <strong>{pending.email}</strong>. Код
                действует ограниченное время. Не сообщайте его другим людям.
              </p>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !busy &&
                  !disabled &&
                  !clock?.expired &&
                  isEmailRegistrationCode(code)
                ) {
                  onConfirm(code);
                  setCode("");
                }
              }}
            >
              <Field
                label="Код из письма"
                className="ym-disable-keys"
                name="emailCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                minLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy || disabled || clock?.expired}
                required
                autoFocus
                hint="6 цифр"
              />
              <div className={styles.actions}>
                <Button
                  type="submit"
                  className="ym-show-content"
                  disabled={
                    busy ||
                    disabled ||
                    clock?.expired ||
                    !isEmailRegistrationCode(code)
                  }
                >
                  {busy ? "Подождите…" : "Подтвердить email"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    busy || disabled || clock?.expired || !!clock?.resendSeconds
                  }
                  onClick={onResend}
                >
                  {clock?.resendSeconds
                    ? `Отправить повторно через ${clock.resendSeconds} с`
                    : "Не пришло письмо? Отправить ещё раз"}
                </Button>
              </div>
            </form>
            <small role="status">
              {clock?.expired
                ? "Срок подтверждения истёк. Вернитесь назад и начните регистрацию заново."
                : "Если письма нет, проверьте папку «Спам» или запросите новый код. Повторная отправка заменит предыдущий код."}
            </small>
          </>
        ) : (
          <>
            <p>Создайте аккаунт, чтобы сохранять диалоги.</p>
            <form
              key={formVersion}
              onSubmit={(event) => {
                event.preventDefault();
                if (!policy || !personalData || busy || disabled) return;
                onRegister(event, {
                  policyVersion: policy.consentPolicy.version,
                  personalData: true,
                  marketing,
                });
              }}
            >
              <Field
                id="registration-email"
                className="ym-disable-keys"
                label="Электронная почта"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                disabled={busy || disabled}
                required
              />
              <Field
                label="Пароль"
                className="ym-disable-keys"
                name="password"
                type="password"
                minLength={6}
                maxLength={128}
                autoComplete="new-password"
                hint="Не менее 6 любых символов"
                disabled={busy || disabled}
                required
              />
              {policy ? (
                <ConsentChoices
                  policy={policy.consentPolicy}
                  personalData={personalData}
                  marketing={marketing}
                  disabled={busy || disabled}
                  onPersonalData={setPersonalData}
                  onMarketing={setMarketing}
                />
              ) : (
                <p role={policyError ? "alert" : "status"}>
                  {policyError || "Загружаем согласия…"}
                </p>
              )}
              {policyError && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPolicyRevision((value) => value + 1)}
                >
                  Обновить согласия
                </Button>
              )}
              <div className={styles.actions}>
                <Button
                  type="submit"
                  disabled={busy || disabled || !policy || !personalData}
                  className="ym-show-content"
                >
                  {busy ? "Подождите…" : "Создать аккаунт"}
                </Button>
                <a
                  href="/legal"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cg-button cg-button-secondary"
                >
                  Правила и данные
                </a>
              </div>
            </form>
          </>
        )}
        <Button variant="secondary" onClick={onBack}>
          {pending ? "← Назад к регистрации" : "Уже есть аккаунт? Войти"}
        </Button>
      </Card>
    </div>
  );
}

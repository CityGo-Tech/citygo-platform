"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, Field } from "@citygo/ui-web";
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
  onRegister,
  onConfirm,
  onResend,
  onBack,
}: {
  pending: PendingEmailRegistration | null;
  busy: boolean;
  disabled: boolean;
  formVersion: number;
  onRegister: (event: FormEvent<HTMLFormElement>) => void;
  onConfirm: (code: string) => void;
  onResend: () => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [now, setNow] = useState(Date.now);
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
            <form key={formVersion} onSubmit={onRegister}>
              <Field
                id="registration-email"
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
                name="password"
                type="password"
                minLength={6}
                maxLength={128}
                autoComplete="new-password"
                hint="Не менее 6 любых символов"
                disabled={busy || disabled}
                required
              />
              <div className={styles.actions}>
                <Button type="submit" disabled={busy || disabled}>
                  {busy ? "Подождите…" : "Создать аккаунт"}
                </Button>
                <a
                  href="https://app.xn--c1ajazlh.xn--p1ai/legal"
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

"use client";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card, Field } from "@citygo/ui-web";
import {
  createPasswordRecoveryLifetime,
  pendingPasswordRecovery,
  recoveryClock,
  recoveryCodeValid,
  recoveryNotice,
  recoveryPasswordError,
  type PendingPasswordRecovery,
} from "./password-recovery-state";
import styles from "./password-recovery.module.css";

/** Figma 6:10/6:93, with a real ephemeral recovery flow, never a demo login. */
export function PasswordRecovery({
  sessionSignal,
  disabled,
  onBack,
  onRecovered,
}: {
  sessionSignal: AbortSignal;
  disabled: boolean;
  onBack: () => void;
  onRecovered: () => void;
}) {
  const scope = useMemo(
    () => createPasswordRecoveryLifetime(sessionSignal),
    [sessionSignal],
  );
  const [policy, setPolicy] = useState<"loading" | "available" | "unavailable">(
    "loading",
  );
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<PendingPasswordRecovery | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [now, setNow] = useState(Date.now);
  const clock = pending ? recoveryClock(pending, now) : null;
  function clearSecrets() {
    setPending(null);
    setCode("");
    setPassword("");
    setRepeated("");
  }
  useEffect(() => {
    const ticket = scope.begin();
    if (ticket) {
      void createClient("/api", { signal: () => ticket.signal })
        .passwordRecoveryPolicy()
        .then((value) => {
          if (ticket.active()) setPolicy(value.passwordRecovery);
        })
        .catch(() => {
          if (ticket.active()) setPolicy("unavailable");
        })
        .finally(() => ticket.finish());
    }
    const invalidate = () => {
      scope.reset();
      clearSecrets();
      setEmail("");
      setBusy(false);
      setError("");
      setStatus("");
    };
    sessionSignal.addEventListener("abort", invalidate);
    return () => {
      sessionSignal.removeEventListener("abort", invalidate);
      scope.dispose();
    };
  }, [scope, sessionSignal]);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (!clock?.expired) return;
    scope.reset();
    clearSecrets();
    setBusy(false);
    setStatus("");
    setError("Срок кода истёк. Начните восстановление заново.");
  }, [clock?.expired, scope]);
  async function submit(
    kind: "begin" | "resend" | "confirm",
    event?: FormEvent,
  ) {
    event?.preventDefault();
    if (disabled || busy || policy !== "available") return;
    if (
      kind !== "begin" &&
      (!pending || recoveryClock(pending, Date.now()).expired)
    )
      return;
    if (
      kind === "resend" &&
      pending &&
      recoveryClock(pending, Date.now()).resendSeconds
    )
      return;
    if (kind === "confirm") {
      const invalid = recoveryPasswordError(password, repeated);
      if (invalid || !recoveryCodeValid(code)) {
        setError(invalid || "Введите 6 цифр из письма.");
        return;
      }
    }
    const ticket = scope.begin();
    if (!ticket) return;
    const current = pending;
    const input = { email, code, password };
    setBusy(true);
    setError("");
    setStatus("");
    // Submitted OTP/password do not remain in mounted inputs during the request.
    setCode("");
    setPassword("");
    setRepeated("");
    const api = createClient("/api", { signal: () => ticket.signal });
    try {
      if (kind === "confirm" && current) {
        await api.confirmPasswordRecovery(
          current.challengeId,
          current.proof,
          input.code,
          input.password,
        );
        ticket.check();
        clearSecrets();
        setEmail("");
        onRecovered(); // Parent invalidates ONLY its still-current client session.
      } else {
        const challenge =
          kind === "resend" && current
            ? await api.resendPasswordRecovery(
                current.challengeId,
                current.proof,
              )
            : await api.beginPasswordRecovery(input.email);
        ticket.check();
        setNow(Date.now());
        setPending(pendingPasswordRecovery(challenge, Date.now()));
        setStatus(
          kind === "resend"
            ? "Если письмо может быть отправлено, новый код заменит предыдущий. Проверьте также папку «Спам»."
            : recoveryNotice,
        );
      }
    } catch (failure) {
      if (ticket.active()) {
        const status =
          failure && typeof failure === "object" && "status" in failure
            ? failure.status
            : null;
        if (status === 410) clearSecrets();
        setError(
          status === 429
            ? "Слишком много попыток. Подождите перед новым запросом."
            : kind === "confirm"
              ? "Не удалось изменить пароль. Проверьте код или начните восстановление заново. Если пароль уже изменён, войдите с новым паролем."
              : "Не удалось выполнить запрос. Попробуйте позже; автоматической повторной отправки нет.",
        );
      }
    } finally {
      input.code = "";
      input.password = "";
      if (ticket.active()) setBusy(false);
      ticket.finish();
    }
  }
  return (
    <div className={styles.workspace}>
      <Card className={styles.card} aria-labelledby="recovery-heading">
        <span className={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</span>
        <h1 id="recovery-heading">Восстановить доступ</h1>
        <p className={styles.intro}>
          {pending
            ? "Введите код из письма и задайте новый пароль. После смены потребуется войти заново."
            : "Восстановление доступно для подтверждённой электронной почты аккаунта."}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <form
          onSubmit={(event) =>
            void submit(pending ? "confirm" : "begin", event)
          }
          aria-busy={busy}
        >
          {!pending ? (
            <Field
              label="Email"
              name="recoveryEmail"
              type="email"
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy || disabled}
              required
            />
          ) : (
            <>
              <Field
                label="Код из письма"
                name="recoveryCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy || disabled}
                required
                autoFocus
              />
              <Field
                label="Новый пароль"
                name="recoveryPassword"
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy || disabled}
                hint="От 6 до 128 любых символов"
                required
              />
              <Field
                label="Повторите новый пароль"
                name="recoveryPasswordRepeat"
                type="password"
                autoComplete="new-password"
                minLength={6}
                maxLength={128}
                value={repeated}
                onChange={(event) => setRepeated(event.target.value)}
                disabled={busy || disabled}
                required
              />
            </>
          )}
          <div className={styles.notice}>
            <strong>Проверьте почту</strong>
            <p>{recoveryNotice}</p>
          </div>
          {policy === "unavailable" && (
            <p className={styles.status} role="status">
              Восстановление временно недоступно. Попробуйте позже.
            </p>
          )}
          <div className={styles.actions}>
            <Button
              type="submit"
              disabled={
                disabled || busy || policy !== "available" || !!clock?.expired
              }
            >
              {busy
                ? "Подождите…"
                : pending
                  ? "Сохранить новый пароль"
                  : policy === "loading"
                    ? "Проверяем доступность…"
                    : "Отправить код"}
            </Button>
            {pending && (
              <Button
                type="button"
                variant="secondary"
                disabled={
                  disabled || busy || !!clock?.expired || !!clock?.resendSeconds
                }
                onClick={() => void submit("resend")}
              >
                {clock?.resendSeconds
                  ? `Отправить повторно через ${clock.resendSeconds} с`
                  : "Отправить код повторно"}
              </Button>
            )}
          </div>
        </form>
        {!!status && (
          <p className={styles.status} role="status">
            {status}
          </p>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            scope.reset();
            clearSecrets();
            setEmail("");
            onBack();
          }}
        >
          ← Назад
        </Button>
      </Card>
    </div>
  );
}

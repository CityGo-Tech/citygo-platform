"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
import type { MessengerProvider } from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import {
  createPhoneVerificationResource,
  isPhoneCode,
  normalizePhone,
  phoneDeliveryLabel,
  type PhoneDeliveryProvider,
  type PhoneVerificationState,
} from "./phone-verification-state";
import { registrationClock } from "./email-registration-state";
import styles from "./phone-verification.module.css";

/** Account-bound, in-memory verification. Opening the panel never sends SMS. */
export function PhoneVerificationPanel({
  userId,
  miniAppProvider,
  sessionSignal,
  onAccessDenied,
  onGranted,
  onClose,
  onOpenBalance,
  onOpenAssistants,
}: {
  userId: string;
  miniAppProvider?: MessengerProvider;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onGranted: () => void;
  onClose: () => void;
  onOpenBalance?: () => void;
  onOpenAssistants?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    provider?: MessengerProvider;
    signal: AbortSignal;
    state: PhoneVerificationState;
  } | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [consentProvider, setConsentProvider] =
    useState<PhoneDeliveryProvider | null>(null);
  const [now, setNow] = useState(Date.now);
  const resource = useRef<ReturnType<
    typeof createPhoneVerificationResource
  > | null>(null);
  const callbacks = useRef({ onAccessDenied, onGranted });
  useEffect(() => {
    callbacks.current = { onAccessDenied, onGranted };
  }, [onAccessDenied, onGranted]);
  useEffect(() => {
    setPhone("");
    setCode("");
    setConsentProvider(null);
    let currentProvider: PhoneDeliveryProvider = "none";
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = createPhoneVerificationResource({
      client: createClient("/api", { signal: () => signal }),
      userId,
      miniAppProvider,
      sessionSignal: signal,
      publish: (state) => {
        if (state.deliveryProvider !== currentProvider) {
          currentProvider = state.deliveryProvider;
          setPhone("");
          setCode("");
          setConsentProvider(null);
        }
        if (
          state.challenge ||
          state.phase === "closed" ||
          state.phase === "confirmed"
        )
          setPhone("");
        if (
          state.phase !== "ready" &&
          state.phase !== "loading" &&
          state.phase !== "recovering"
        ) {
          setPhone("");
          setCode("");
          setConsentProvider(null);
        }
        setSnapshot({
          owner: userId,
          provider: miniAppProvider,
          signal: sessionSignal,
          state,
        });
      },
      onAccessDenied: () => callbacks.current.onAccessDenied(),
      onGranted: () => callbacks.current.onGranted(),
    });
    resource.current = current;
    void current.load();
    return () => {
      current.dispose();
      controller.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [userId, miniAppProvider, sessionSignal]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Do not render previous-owner data in the render preceding effect cleanup.
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.provider === miniAppProvider &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  const clock = state?.challenge
    ? registrationClock(state.challenge, now)
    : null;
  const waiting = Math.max(
    clock?.resendSeconds ?? 0,
    Math.ceil(((state?.retryAt ?? 0) - now) / 1000),
    0,
  );
  const codeSeconds = state?.challenge
    ? Math.max(
        0,
        Math.ceil((Date.parse(state.challenge.expiresAt) - now) / 1000),
      )
    : 0;
  const busy = !state || state.busy;
  const providerLabel = state
    ? phoneDeliveryLabel(state.deliveryProvider)
    : null;
  const consent =
    !!state &&
    state.deliveryProvider !== "none" &&
    consentProvider === state.deliveryProvider;
  const completed =
    state?.phase === "confirmed" || state?.phase === "recovered";
  const heading = miniAppProvider
    ? completed
      ? state?.receipt?.alreadyGranted === false
        ? "Подарок начислен"
        : "Телефон подтверждён"
      : state?.phase === "number-unavailable"
        ? "Не удалось привязать номер"
        : state?.phase === "ready" && state.challenge
          ? "Код из SMS"
          : "Подтвердить телефон"
    : "Подтверждение телефона";
  return (
    <Card
      className={`${styles.panel}${miniAppProvider ? ` ${styles.miniPanel}` : ""} ym-hide-content ym-disable-keys`}
      aria-labelledby="phone-gift-heading"
    >
      {!miniAppProvider && (
        <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ · CITYGO</span>
      )}
      <h1 id="phone-gift-heading" tabIndex={-1}>
        {heading}
      </h1>
      {!miniAppProvider && state?.phase !== "phone-bound" && (
        <p>Разовый подарок 500 ₽ CityGo после подтверждения номера.</p>
      )}
      {(!state || state.phase === "loading") && (
        <p role="status">Проверяем доступность подарка…</p>
      )}
      {state?.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state?.phase === "disabled" && (
        <p role="status">Подтверждение телефона пока недоступно.</p>
      )}
      {state?.phase === "unavailable" && (
        <p role="status">
          Не удалось загрузить подтверждение. Попробуйте позже.
        </p>
      )}
      {state?.phase === "email-required" && (
        <p role="status">
          Сначала подтвердите электронную почту. Если нужна помощь, обратитесь в
          поддержку.
        </p>
      )}
      {state?.phase === "already-granted" && (
        <p role="status">Подарок уже получен.</p>
      )}
      {state?.phase === "phone-bound" && (
        <p role="status">
          Телефон привязан. Подарок по этому номеру уже использован.
        </p>
      )}
      {state?.phase === "closed" && (
        <p role="status">
          Сессия завершилась. Войдите снова, чтобы продолжить.
        </p>
      )}
      {completed && (
        <div className={styles.notice} role="status">
          <strong>
            {state.receipt?.alreadyGranted === false
              ? "Телефон подтверждён. Начислено 500 ₽ CityGo."
              : "Телефон подтверждён. Подарок уже был начислен."}
          </strong>
        </div>
      )}
      {completed && miniAppProvider && onOpenBalance && (
        <Button type="button" onClick={onOpenBalance}>
          Посмотреть баланс
        </Button>
      )}
      {completed && miniAppProvider && onOpenAssistants && (
        <Button type="button" variant="secondary" onClick={onOpenAssistants}>
          К помощникам
        </Button>
      )}
      {state?.phase === "recovering" && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void resource.current?.load()}
        >
          Проверить подтверждение
        </Button>
      )}
      {state?.phase === "number-unavailable" && (
        <Button
          type="button"
          disabled={busy}
          onClick={() => void resource.current?.load()}
        >
          Указать другой номер
        </Button>
      )}
      {state?.phase === "ready" && providerLabel && (
        <>
          {miniAppProvider && !state.challenge && (
            <p>За подтверждение номера начислим 500 ₽ на баланс CityGo.</p>
          )}
          {(!miniAppProvider || !state.challenge) && (
            <details>
              <summary>Условия подтверждения</summary>
              <p>
                Для доставки SMS номер и код передаются сервису {providerLabel}{" "}
                только для подтверждения телефона.
              </p>
            </details>
          )}
          {state.challenge ? (
            <>
              <p>
                Введите код из SMS для{" "}
                <strong>{state.challenge.maskedPhone}</strong>.
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy && !clock?.expired && isPhoneCode(code)) {
                    const submitted = code;
                    setCode("");
                    void resource.current?.confirm(submitted);
                  }
                }}
              >
                <Field
                  label={miniAppProvider ? "Код подтверждения" : "Код из SMS"}
                  className="ym-disable-keys"
                  name="phoneCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  minLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  disabled={busy || clock?.expired}
                  hint="6 цифр из последней SMS"
                />
                <Button
                  type="submit"
                  className="ym-show-content"
                  disabled={busy || clock?.expired || !isPhoneCode(code)}
                >
                  {busy
                    ? "Подождите…"
                    : miniAppProvider
                      ? "Подтвердить номер"
                      : "Подтвердить телефон и получить подарок"}
                </Button>
              </form>
              {clock?.expired ? (
                <small role="status">
                  Срок кода истёк. Начните подтверждение заново.
                </small>
              ) : (
                <small>
                  Код действует ещё {Math.floor(codeSeconds / 60)} мин{" "}
                  {codeSeconds % 60} с. Никому не сообщайте код.
                </small>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !!waiting || clock?.expired || !consent}
                onClick={() => {
                  setCode("");
                  void resource.current?.resend(consent);
                }}
              >
                {waiting
                  ? `Отправить SMS повторно через ${waiting} с`
                  : "Отправить SMS ещё раз"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setCode("");
                  setPhone("");
                  setConsentProvider(null);
                  resource.current?.reset();
                }}
              >
                {miniAppProvider ? "Указать другой номер" : "Изменить номер"}
              </Button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && !waiting && consent && normalizePhone(phone))
                  void resource.current?.start(phone, consent);
              }}
            >
              <Field
                label={
                  miniAppProvider
                    ? "Номер телефона"
                    : "Российский мобильный номер"
                }
                className="ym-disable-keys"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                maxLength={32}
                onChange={(event) => setPhone(event.target.value)}
                disabled={busy}
                placeholder="+7 999 123-45-67"
                required
              />
              {phone && !normalizePhone(phone) && (
                <small>
                  Укажите российский мобильный номер +7 9XX XXX-XX-XX.
                </small>
              )}
              {miniAppProvider && (
                <small>Один подарок на аккаунт и номер.</small>
              )}
              <label className={styles.consent}>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(event) =>
                    setConsentProvider(
                      event.target.checked ? state.deliveryProvider : null,
                    )
                  }
                />
                <span>Согласен на подтверждение номера по SMS.</span>
              </label>
              <Button
                type="submit"
                className="ym-show-content"
                disabled={
                  busy || !!waiting || !consent || !normalizePhone(phone)
                }
              >
                {busy
                  ? "Запрашиваем SMS…"
                  : waiting
                    ? `Запросить SMS через ${waiting} с`
                    : "Получить код по SMS"}
              </Button>
            </form>
          )}
        </>
      )}
      {(state?.phase === "ready" ||
        state?.phase === "unavailable" ||
        state?.phase === "disabled" ||
        state?.phase === "already-granted" ||
        state?.phase === "phone-bound" ||
        state?.phase === "email-required") && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void resource.current?.load()}
        >
          {state?.phase === "phone-bound"
            ? "Обновить статус"
            : "Обновить статус подарка"}
        </Button>
      )}
      <Button type="button" variant="secondary" onClick={onClose}>
        Вернуться в приложение
      </Button>
    </Card>
  );
}

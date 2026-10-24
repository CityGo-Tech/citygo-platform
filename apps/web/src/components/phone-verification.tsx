"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@citygo/api-client";
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
  sessionSignal,
  onAccessDenied,
  onGranted,
  onClose,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onGranted: () => void;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
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
        if (state.phase !== "ready" && state.phase !== "loading") {
          setPhone("");
          setCode("");
          setConsentProvider(null);
        }
        setSnapshot({ owner: userId, signal: sessionSignal, state });
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
  }, [userId, sessionSignal]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // Do not render previous-owner data in the render preceding effect cleanup.
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
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
  const busy = !state || state.busy;
  const providerLabel = state
    ? phoneDeliveryLabel(state.deliveryProvider)
    : null;
  const consent =
    !!state &&
    state.deliveryProvider !== "none" &&
    consentProvider === state.deliveryProvider;
  return (
    <Card className={styles.panel} aria-labelledby="phone-gift-heading">
      <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ · CITYGO</span>
      <h1 id="phone-gift-heading">Подарок 500 ₽ CityGo</h1>
      <p>
        Один подарок после подтверждения вашего российского мобильного номера.
        Это баланс для общения с помощниками, не выплата денег и не пополнение
        картой.
      </p>
      {(!state || state.phase === "loading") && (
        <p role="status">Проверяем доступность подарка…</p>
      )}
      {state?.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state?.phase === "disabled" && (
        <p role="status">
          Подтверждение телефона пока выключено. В этом разделе подарок сейчас
          не выдаётся; текущий остаток смотрите на балансе.
        </p>
      )}
      {state?.phase === "unavailable" && (
        <p role="status">
          Подтверждение телефона временно недоступно. В этом разделе подарок
          сейчас не выдаётся; текущий остаток смотрите на балансе. SMS не
          отправляется автоматически.
        </p>
      )}
      {state?.phase === "email-required" && (
        <p role="status">
          Сначала подтвердите электронную почту аккаунта. Без подтверждённого
          email SMS и подарок недоступны. Если у вас старый аккаунт, обратитесь
          в поддержку CityGo.
        </p>
      )}
      {state?.phase === "already-granted" && (
        <p role="status">
          Разовый подарок уже использован для этого аккаунта. Новый подарок не
          начислялся. Текущий остаток смотрите на балансе.
        </p>
      )}
      {state?.phase === "closed" && (
        <p role="status">
          Сессия завершилась. Войдите снова, чтобы продолжить.
        </p>
      )}
      {state?.phase === "confirmed" && state.receipt && (
        <div className={styles.notice} role="status">
          <strong>
            {state.receipt.alreadyGranted
              ? "Телефон подтверждён. Подарок уже был начислен."
              : "Телефон подтверждён. Начислено 500 ₽ CityGo."}
          </strong>
          <p>
            {state.receipt.alreadyGranted
              ? "Повторного начисления нет."
              : "Баланс обновляется по данным сервера."}{" "}
            Дальнейшее использование подарка отражается в остатке баланса.
          </p>
        </div>
      )}
      {state?.phase === "ready" && providerLabel && (
        <>
          <div className={styles.notice}>
            <strong>Подтверждение номера</strong>
            <p>
              По вашему действию CityGo передаст номер и код сервису{" "}
              {providerLabel} только для SMS-подтверждения. История диалогов с
              ИИ и сообщения помощников не передаются. Код и данные
              подтверждения не сохраняются в браузерном хранилище. При выходе из
              раздела потребуется начать заново.
            </p>
          </div>
          {state.challenge ? (
            <>
              <p>
                Код запрошен для <strong>{state.challenge.maskedPhone}</strong>.
                Получение SMS само по себе не начисляет подарок.
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
                  label="Код из SMS"
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
                  disabled={busy || clock?.expired || !isPhoneCode(code)}
                >
                  {busy
                    ? "Подождите…"
                    : "Подтвердить телефон и получить подарок"}
                </Button>
              </form>
              <small role="status">
                {clock?.expired
                  ? "Срок кода истёк. Начните подтверждение заново."
                  : "Никому не сообщайте код. Повторная SMS заменяет предыдущий код."}
              </small>
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
                Изменить номер / начать заново
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
                label="Российский мобильный номер"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                maxLength={32}
                onChange={(event) => setPhone(event.target.value)}
                disabled={busy}
                placeholder="+7 999 123-45-67"
                hint="Подойдут +7 9XX…, 7 9XX… или 8 9XX…"
                required
              />
              {phone && !normalizePhone(phone) && (
                <small>
                  Укажите российский мобильный номер +7 9XX XXX-XX-XX.
                </small>
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
                <span>
                  Согласен на передачу моего номера и кода сервису{" "}
                  {providerLabel} только для SMS-подтверждения.
                </span>
              </label>
              <Button
                type="submit"
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
        state?.phase === "email-required") && (
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void resource.current?.load()}
        >
          Обновить статус подарка
        </Button>
      )}
      <Button type="button" variant="secondary" onClick={onClose}>
        Вернуться в приложение
      </Button>
    </Card>
  );
}

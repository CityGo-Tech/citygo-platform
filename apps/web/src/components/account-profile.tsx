"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@citygo/api-client";
import { formatSignedMoneyMicros, type AiAccess } from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import { accountStyles } from "./account-overview";
import { registrationClock } from "./email-registration-state";
import {
  createAccountProfileResource,
  isAccountEmailCode,
  type AccountProfileState,
} from "./account-profile.state";
import "./account-profile.css";

/** Figma 6:64 result-card pattern with actual account/contact status. */
export function AccountProfile({
  userId,
  sessionSignal,
  onAccessDenied,
  access,
  disabled,
  admin,
  onBalance,
  onPhone,
  onFavorites,
  onPassword,
  onSupport,
  onResults,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  access: AiAccess;
  disabled: boolean;
  admin: boolean;
  onBalance?: () => void;
  onPhone?: () => void;
  onFavorites?: () => void;
  onPassword?: () => void;
  onSupport?: () => void;
  onResults?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{
    owner: string;
    signal: AbortSignal;
    state: AccountProfileState;
  } | null>(null);
  const [code, setCode] = useState("");
  const [now, setNow] = useState(Date.now);
  const resource = useRef<ReturnType<
    typeof createAccountProfileResource
  > | null>(null);
  const denied = useRef(onAccessDenied);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  useEffect(() => {
    setCode("");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = createAccountProfileResource({
      userId,
      client: createClient("/api", { signal: () => signal }),
      sessionSignal: signal,
      publish: (state) => {
        if (!state.challenge || state.busy || state.phase === "closed")
          setCode("");
        setSnapshot({ owner: userId, signal: sessionSignal, state });
      },
      onAccessDenied: () => denied.current(),
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
  // Also hide a prior owner in the render before effect cleanup is committed.
  const state =
    !sessionSignal.aborted &&
    snapshot?.owner === userId &&
    snapshot.signal === sessionSignal
      ? snapshot.state
      : null;
  if (sessionSignal.aborted || state?.phase === "closed") return null;
  const profile = state?.profile ?? null;
  const clock = state?.challenge
    ? registrationClock(state.challenge, now)
    : null;
  const waiting = Math.max(
    clock?.resendSeconds ?? 0,
    Math.ceil(((state?.retryAt ?? 0) - now) / 1000),
    0,
  );
  const working = !!state?.busy || disabled;
  const request = () => {
    setCode("");
    void resource.current?.request();
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (working || clock?.expired || !isAccountEmailCode(code)) return;
    const submitted = code;
    setCode("");
    void resource.current?.confirm(submitted);
  };
  return (
    <Card
      className={accountStyles.page + " account-profile"}
      aria-labelledby="account-profile-heading"
      aria-busy={!!state?.busy}
    >
      <span className={accountStyles.eyebrow}>ВАШ CITYGO</span>
      <h1 id="account-profile-heading">Личный кабинет</h1>

      <section
        className={accountStyles.profileCard}
        aria-labelledby="profile-balance-heading"
      >
        <span className={accountStyles.eyebrow}>БАЛАНС CITYGO</span>
        <h2 id="profile-balance-heading" className="account-profile-balance">
          {access.credit
            ? `${formatSignedMoneyMicros(access.credit.availableMicros)} ₽`
            : "Баланс недоступен"}
        </h2>
        <p>Для общения с помощниками.</p>
        <Button disabled={disabled} onClick={onBalance}>
          Баланс и пополнение
        </Button>
      </section>

      <section
        className={accountStyles.profileCard}
        aria-labelledby="profile-email-heading"
      >
        <span className={accountStyles.eyebrow}>КОНТАКТЫ АККАУНТА</span>
        <h2 id="profile-email-heading">Электронная почта</h2>
        {(!state || state.phase === "loading") && (
          <p role="status">Загружаем профиль…</p>
        )}
        {state?.phase === "unavailable" && (
          <p>Проверьте подключение и обновите статус профиля.</p>
        )}
        {profile && (
          <>
            <p className="account-profile-contact">
              {profile.email ?? "Почта не указана"}
            </p>
            <p
              role={profile.emailVerified ? "status" : undefined}
              className={
                profile.emailVerified
                  ? "account-profile-confirmed"
                  : "account-profile-muted"
              }
            >
              {profile.email
                ? profile.emailVerified
                  ? "Email подтверждён"
                  : "Email не подтверждён"
                : "Для входа используется логин."}
            </p>
            {profile.email &&
              !profile.emailVerified &&
              profile.emailConfirmation === "unavailable" && (
                <p>Подтверждение email пока недоступно.</p>
              )}
            {profile.email &&
              !profile.emailVerified &&
              profile.emailConfirmation === "available" &&
              (state?.challenge ? (
                <div
                  className="account-profile-confirmation"
                  aria-label="Подтверждение email"
                >
                  {clock?.expired ? (
                    <>
                      <p role="status">
                        Срок действия кода истёк. Запросите новый код.
                      </p>
                      <Button
                        disabled={working || waiting > 0}
                        onClick={request}
                      >
                        Получить новый код
                      </Button>
                    </>
                  ) : (
                    <form onSubmit={confirm}>
                      <Field
                        label="Код из письма"
                        name="accountEmailCode"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        minLength={6}
                        maxLength={6}
                        required
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        disabled={working}
                        hint="6 цифр из последнего письма"
                      />
                      <div className="account-profile-actions">
                        <Button
                          type="submit"
                          disabled={working || !isAccountEmailCode(code)}
                        >
                          {state.busy === "confirm"
                            ? "Подтверждаем…"
                            : "Подтвердить email"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={working || waiting > 0}
                          onClick={() => {
                            setCode("");
                            void resource.current?.resend();
                          }}
                        >
                          {waiting > 0
                            ? `Отправить повторно через ${waiting} с`
                            : "Отправить код повторно"}
                        </Button>
                      </div>
                    </form>
                  )}
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setCode("");
                      resource.current?.cancelEmail();
                    }}
                  >
                    Отменить подтверждение
                  </Button>
                </div>
              ) : (
                <Button disabled={working || waiting > 0} onClick={request}>
                  {state?.busy === "request"
                    ? "Отправляем…"
                    : waiting > 0
                      ? `Получить код через ${waiting} с`
                      : "Подтвердить email"}
                </Button>
              ))}
          </>
        )}
        {state?.error && (
          <p role="alert" className="account-profile-error">
            {state.error}
          </p>
        )}
        {state?.notice && !profile?.emailVerified && (
          <p role="status">{state.notice}</p>
        )}
        {state && ["ready", "unavailable"].includes(state.phase) && (
          <Button
            variant="secondary"
            className="account-profile-refresh"
            disabled={disabled || !!state.busy}
            onClick={() => void resource.current?.load()}
          >
            Обновить статус профиля
          </Button>
        )}
      </section>

      <section
        className={accountStyles.profileCard}
        aria-labelledby="profile-phone-heading"
      >
        <span className={accountStyles.eyebrow}>ТЕЛЕФОН</span>
        <h2 id="profile-phone-heading">Телефон и подарок</h2>
        <p>
          {profile
            ? profile.phoneVerified
              ? "Телефон подтверждён"
              : "Телефон не подтверждён"
            : "Статус телефона пока недоступен."}
        </p>
        {profile?.giftStatus === "claimed" && (
          <p>Подарок 500 ₽ CityGo уже начислен.</p>
        )}
        {profile?.giftStatus === "available" && (
          <p>
            {profile.emailVerified
              ? "500 ₽ CityGo в подарок после подтверждения телефона."
              : "Подтвердите email, затем телефон — и получите 500 ₽ CityGo."}
          </p>
        )}
        {profile?.giftStatus === "unavailable" && (
          <p>Подарок пока недоступен.</p>
        )}
        <Button variant="secondary" disabled={disabled} onClick={onPhone}>
          Телефон и подарок
        </Button>
      </section>

      <section
        className={accountStyles.profileCard}
        aria-labelledby="profile-saved-heading"
      >
        <span className={accountStyles.eyebrow}>ВАЖНОЕ ПОД РУКОЙ</span>
        <h2 id="profile-saved-heading">Избранные сообщения</h2>
        <p>Сохранённые вопросы и ответы помощников.</p>
        <Button variant="secondary" disabled={disabled} onClick={onFavorites}>
          Избранные сообщения
        </Button>
      </section>
      {onResults && (
        <section
          className={accountStyles.profileCard}
          aria-labelledby="profile-results-heading"
        >
          <span className={accountStyles.eyebrow}>ВАШИ МАТЕРИАЛЫ</span>
          <h2 id="profile-results-heading">Полезные результаты</h2>
          <p>Планы, чек-листы и черновики из разговоров.</p>
          <Button variant="secondary" disabled={disabled} onClick={onResults}>
            Открыть результаты
          </Button>
        </section>
      )}
      <div className="account-profile-actions">
        <Button variant="secondary" onClick={onSupport}>
          Помощь человека
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={onPassword}>
          Изменить пароль
        </Button>
        <Link href="/legal">Правила и данные</Link>
        {admin && <Link href="/admin">Открыть админку сервиса</Link>}
      </div>
    </Card>
  );
}

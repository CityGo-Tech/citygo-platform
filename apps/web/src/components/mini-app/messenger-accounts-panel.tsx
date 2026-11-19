"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createClient } from "@citygo/api-client";
import type { MessengerProvider } from "@citygo/contracts";
import { Button, Card, Field } from "@citygo/ui-web";
import { messengerNames, type MiniAppAccountAccess } from "./account-access";

type Account = { id: string; email: string };
type PreparedLink = Account & { confirmation: string };
type LinkAction = { provider: MessengerProvider; action: "unlink" | "revoke" };

export function MessengerAccountsPanel({
  owner,
  miniApp,
  sessionSignal,
  onAccessDenied,
  onSessionRevocation,
  onSwitchAccount,
  onClose,
}: {
  owner: Account;
  miniApp?: MiniAppAccountAccess;
  sessionSignal: AbortSignal;
  onAccessDenied: () => void;
  onSessionRevocation: () => void;
  onSwitchAccount: () => void;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<MessengerProvider[]>();
  const [prepared, setPrepared] = useState<PreparedLink>();
  const [pendingAction, setPendingAction] = useState<LinkAction>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController>(null);
  const locked = useRef(false);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () =>
          lifetime.current
            ? AbortSignal.any([lifetime.current.signal, sessionSignal])
            : sessionSignal,
        onUnauthorized: () => {
          if (!sessionSignal.aborted) onAccessDenied();
        },
      }),
    [sessionSignal],
  );

  async function readLinks(signal: AbortSignal) {
    const result = await api.messengerLinks();
    if (!signal.aborted && !sessionSignal.aborted)
      setProviders(result.providers);
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void readLinks(controller.signal).catch(() => {
      if (!controller.signal.aborted && !sessionSignal.aborted)
        setError("Не удалось загрузить подключённые мессенджеры.");
    });
    return () => controller.abort();
  }, [api, sessionSignal]);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || sessionSignal.aborted || locked.current)
      return;
    locked.current = true;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await work(signal);
    } catch (cause) {
      if (!signal.aborted && !sessionSignal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось выполнить действие.",
        );
    } finally {
      locked.current = false;
      if (!signal.aborted && !sessionSignal.aborted) setBusy(false);
    }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!miniApp?.initData || locked.current) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    form.reset();
    void run(async (signal) => {
      const result = await api.prepareMessengerLink(
        miniApp.provider,
        miniApp.initData,
        password,
      );
      if (signal.aborted || sessionSignal.aborted) return;
      if (result.id !== owner.id || result.email !== owner.email) {
        onAccessDenied();
        return;
      }
      setPrepared(result);
    });
  }

  function confirmLink() {
    if (!miniApp?.initData || !prepared || prepared.id !== owner.id) return;
    const { confirmation } = prepared;
    setPrepared(undefined);
    void run(async (signal) => {
      await api.linkMessenger(
        miniApp.provider,
        miniApp.initData,
        owner.id,
        confirmation,
      );
      if (signal.aborted || sessionSignal.aborted) return;
      setProviders((current) => [
        ...new Set([...(current ?? []), miniApp.provider]),
      ]);
      setNotice(`${messengerNames[miniApp.provider]} подключён.`);
    });
  }

  function confirmAction() {
    if (!pendingAction) return;
    const { provider, action } = pendingAction;
    setPendingAction(undefined);
    void run(async (signal) => {
      if (action === "unlink") await api.unlinkMessenger(provider);
      else await api.revokeMessengerSessions(provider);
      if (signal.aborted || sessionSignal.aborted) return;
      setNotice(
        action === "unlink"
          ? "Мессенджер отвязан."
          : "Сессии мессенджера завершены.",
      );
      if (action === "unlink")
        setProviders((current) =>
          current?.filter((candidate) => candidate !== provider),
        );
      onSessionRevocation();
    });
  }

  return (
    <Card className="auth-card ym-hide-content" data-citygo-analytics-private>
      <h1>Подключённые мессенджеры</h1>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!providers && !error && <p role="status">Загружаем подключения…</p>}
      {!providers && error && (
        <Button onClick={() => void run(readLinks)} disabled={busy}>
          Повторить
        </Button>
      )}
      {pendingAction ? (
        <>
          <p>
            {pendingAction.action === "unlink"
              ? "Отвязать"
              : "Завершить сессии"}{" "}
            {messengerNames[pendingAction.provider]}?
          </p>
          <Button onClick={confirmAction} disabled={busy}>
            Подтвердить
          </Button>
          <Button variant="ghost" onClick={() => setPendingAction(undefined)}>
            Отмена
          </Button>
        </>
      ) : prepared && miniApp ? (
        <>
          <p>
            Подключить {messengerNames[miniApp.provider]} к аккаунту{" "}
            {prepared.email}?
          </p>
          <Button onClick={confirmLink} disabled={busy}>
            Подключить {messengerNames[miniApp.provider]}
          </Button>
        </>
      ) : (
        providers && (
          <>
            {providers.map((provider) => (
              <section key={provider} aria-label={messengerNames[provider]}>
                <h2>{messengerNames[provider]}</h2>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    setPendingAction({ provider, action: "revoke" })
                  }
                >
                  Завершить сессии
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setPendingAction({ provider, action: "unlink" })
                  }
                >
                  Отвязать
                </Button>
              </section>
            ))}
            {miniApp?.initData && !providers.includes(miniApp.provider) ? (
              <form onSubmit={prepare}>
                <p>Чтобы подключить мессенджер, подтвердите пароль CityGo.</p>
                <Field
                  label="Пароль CityGo"
                  className="ym-disable-keys"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                  disabled={busy}
                />
                <Button type="submit" disabled={busy}>
                  Проверить пароль
                </Button>
              </form>
            ) : !providers.length ? (
              <p>Мессенджеры можно подключить из мини-приложения.</p>
            ) : null}
          </>
        )
      )}
      {miniApp && (
        <Button variant="ghost" disabled={busy} onClick={onSwitchAccount}>
          Сменить аккаунт
        </Button>
      )}
      <Button variant="secondary" disabled={busy} onClick={onClose}>
        {miniApp ? "Не сейчас" : "Назад"}
      </Button>
    </Card>
  );
}

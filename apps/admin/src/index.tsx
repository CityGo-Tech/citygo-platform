"use client";
import { useEffect, useMemo, useState } from "react";
import {
  createClient,
  createSessionGuard,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import { Button, Card } from "@citygo/ui-web";
import { AiControls } from "./ai-control.js";
import { AiBudgetControls } from "./ai-budget.js";
import { AiCreditControls } from "./ai-credit.js";
export function AdminOverview() {
  const [session] = useState(createSessionGuard);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => session.capture().signal,
        onUnauthorized: () => invalidate(),
      }),
    [session],
  );
  const [data, setData] = useState<Awaited<
      ReturnType<typeof api.admin>
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [control, setControl] = useState<Awaited<
    ReturnType<typeof api.aiControl>
  > | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [notice, setNotice] = useState("");
  function invalidate() {
    session.reset();
    setData(null);
    setControl(null);
    setError("");
    setNotice("");
    setBusy(false);
    setRefreshVersion((value) => value + 1);
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(invalidate);
    // Revalidate explicitly after returning from another app/tab, including
    // browsers where storage events are unavailable. Never keep a stale admin form.
    window.addEventListener("focus", invalidate);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", invalidate);
      session.reset();
    };
  }, []);
  async function saveBudget(input: Parameters<typeof api.setAiBudget>[0]) {
    const ticket = session.capture();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.setAiBudget(input);
      ticket.check();
      setNotice("Денежный бюджет AI сохранён.");
    } catch (error) {
      if (ticket.active())
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось сохранить бюджет",
        );
    } finally {
      try {
        if (ticket.active()) await refresh(ticket);
      } catch (error) {
        if (ticket.active())
          setError(
            error instanceof Error
              ? error.message
              : "Не удалось обновить сводку",
          );
      } finally {
        if (ticket.active()) setBusy(false);
      }
    }
  }
  async function refresh(ticket = session.capture()) {
    try {
      ticket.check();
      const [overview, ai] = await Promise.all([api.admin(), api.aiControl()]);
      ticket.check();
      setData(overview);
      setControl(ai);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      if (ticket.active()) {
        setData(null);
        setControl(null);
        setNotice("");
      }
      throw error;
    }
  }
  return (
    <main>
      <Card>
        <h1>CityGo · Администрирование</h1>
        <p>
          Войдите в Web под аккаунтом, чей внутренний ID включён в серверный
          ADMIN_USER_IDS.
        </p>
        <Button
          disabled={busy}
          onClick={() => {
            const ticket = session.capture();
            setBusy(true);
            setError("");
            setNotice("");
            void refresh(ticket)
              .catch((e) => {
                if (ticket.active()) setError(e.message);
              })
              .finally(() => {
                if (ticket.active()) setBusy(false);
              });
          }}
        >
          Обновить сводку
        </Button>
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {data && (
          <>
            <h2>Основной сценарий</h2>
            <p>
              Пользователей: {data.counts.users} · Завершённых квестов:{" "}
              {data.counts.completed} · Выдано XP: {data.counts.xp}
            </p>
            <h2>Запросы помощи человека</h2>
            <p>Это очередь запросов, а не подтверждение связи с риелтором.</p>
            {data.pendingHuman.length ? (
              data.pendingHuman.map((h) => (
                <p key={h.id}>
                  Чат {h.thread_id}: {h.reason}
                </p>
              ))
            ) : (
              <p>Запросов пока нет</p>
            )}
          </>
        )}
      </Card>
      {control && (
        <AiControls
          key={refreshVersion}
          status={control}
          busy={busy}
          onSave={(input) => {
            const ticket = session.capture();
            setBusy(true);
            setError("");
            setNotice("");
            void (async () => {
              try {
                await api.setAiRouting(input);
                ticket.check();
                setNotice("Настройка AI сохранена.");
              } catch (error) {
                if (ticket.active())
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Не удалось изменить настройку AI",
                  );
              } finally {
                try {
                  if (ticket.active()) await refresh(ticket);
                } catch (error) {
                  if (ticket.active())
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Не удалось обновить сводку",
                    );
                } finally {
                  if (ticket.active()) setBusy(false);
                }
              }
            })();
          }}
        />
      )}
      {control?.budget && (
        <AiBudgetControls
          key={`budget-${refreshVersion}`}
          status={control.budget}
          busy={busy}
          onSave={(input) => {
            void saveBudget(input);
          }}
        />
      )}
      {control && (
        <AiCreditControls
          key={`credit-${refreshVersion}`}
          busy={busy}
          onGrant={(input) => {
            const ticket = session.capture();
            setBusy(true);
            setError("");
            setNotice("");
            void (async () => {
              try {
                await api.grantWelcomeCredit(input);
                ticket.check();
                setNotice(
                  `Разовый бонус 500 ₽ подтверждён для аккаунта ${input.userId}. Повторного начисления нет.`,
                );
              } catch (error) {
                if (ticket.active())
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Не удалось подтвердить бонус",
                  );
              } finally {
                if (ticket.active()) setBusy(false);
              }
            })();
          }}
        />
      )}
    </main>
  );
}

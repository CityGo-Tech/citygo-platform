"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  createSessionGuard,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import type { AccountRole, AccountUser } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { AiControls } from "./ai-control.js";
import { AiBudgetControls } from "./ai-budget.js";
import { AiCreditControls } from "./ai-credit.js";
import { AccountsControl } from "./accounts-control.js";
import { NpdReceiptsControl } from "./npd-receipts.js";
import { PaymentRefundsControl } from "./payment-refunds.js";
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
  const [viewer, setViewer] = useState<AccountUser | null>(null);
  const [users, setUsers] = useState<AccountUser[] | null>(null);
  const roleMutation = useRef<object | null>(null);
  function invalidate() {
    session.reset();
    setData(null);
    setControl(null);
    setViewer(null);
    setUsers(null);
    roleMutation.current = null;
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
      const [overview, ai, dashboard] = await Promise.all([
        api.admin(),
        api.aiControl(),
        api.dashboard(),
      ]);
      ticket.check();
      if (session.ownerChanged(dashboard.user.id)) {
        invalidate();
        throw new Error(
          "Аккаунт изменился. Обновите сводку под текущим аккаунтом.",
        );
      }
      const accounts =
        dashboard.user.role === "super_admin" ? await api.accountUsers() : null;
      ticket.check();
      setData(overview);
      setControl(ai);
      setViewer(dashboard.user);
      setUsers(accounts?.users ?? null);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      if (ticket.active()) {
        setData(null);
        setControl(null);
        setViewer(null);
        setUsers(null);
        setNotice("");
      }
      throw error;
    }
  }
  async function saveRole(userId: string, role: AccountRole) {
    if (roleMutation.current || busy || viewer?.role !== "super_admin") return;
    const mutation = {};
    roleMutation.current = mutation;
    const ticket = session.capture();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.setAccountRole(userId, role);
      ticket.check();
      if (userId === viewer.id && role === "user") {
        invalidate();
        setNotice(
          "Ваша роль изменена на пользователя. Доступ к админке закрыт.",
        );
        return;
      }
      setNotice(`Роль аккаунта ${userId} сохранена.`);
      await refresh(ticket);
    } catch (error) {
      if (ticket.active()) {
        if (error instanceof ApiError && error.status === 403) {
          setUsers(null);
          setViewer(null);
        }
        setError(
          error instanceof Error
            ? error.message
            : "Не удалось изменить роль. Обновите сводку перед повтором.",
        );
      }
    } finally {
      if (roleMutation.current === mutation) roleMutation.current = null;
      if (ticket.active()) setBusy(false);
    }
  }
  return (
    <main>
      <Card>
        <h1>CityGo · Администрирование</h1>
        <p>
          Войдите в Web под аккаунтом администратора или super admin и обновите
          сводку. Управление ролями доступно только super admin. Временный
          пароль нужно сменить до открытия админки.
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
      {viewer?.role === "super_admin" && users && (
        <AccountsControl
          key={`accounts-${refreshVersion}`}
          users={users}
          viewerId={viewer.id}
          busy={busy}
          onSave={(userId, role) => void saveRole(userId, role)}
        />
      )}
      {viewer && viewer.role !== "super_admin" && (
        <Card>
          <h2>Аккаунты и роли</h2>
          <p>
            Управление ролями доступно только super admin. Ваши права
            администратора не позволяют выдавать роли.
          </p>
        </Card>
      )}
      {viewer && (
        <NpdReceiptsControl
          key={`npd-${viewer.id}-${refreshVersion}`}
          viewerId={viewer.id}
          onAccessLost={() => {
            invalidate();
            setError(
              "Доступ к реестру или сессия изменились. Войдите под администратором и обновите сводку.",
            );
          }}
        />
      )}
      {viewer && (
        <PaymentRefundsControl
          key={`refunds-${viewer.id}-${refreshVersion}`}
          viewerId={viewer.id}
          onAccessLost={() => {
            invalidate();
            setError(
              "Доступ к возвратам или сессия изменились. Войдите под администратором и обновите сводку.",
            );
          }}
        />
      )}
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
          onReconcile={(input) => {
            const ticket = session.capture();
            setBusy(true);
            setError("");
            setNotice("");
            void (async () => {
              try {
                await api.reconcileCredit(input);
                ticket.check();
                setNotice(
                  "Стоимость сверена. Повторного вызова модели и повторного списания нет.",
                );
              } catch (error) {
                if (ticket.active())
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Не удалось сверить стоимость",
                  );
              } finally {
                if (ticket.active()) setBusy(false);
              }
            })();
          }}
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

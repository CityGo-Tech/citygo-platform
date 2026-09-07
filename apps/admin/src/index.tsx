"use client";
import { useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card } from "@citygo/ui-web";
import { AiControls } from "./ai-control.js";
import { AiBudgetControls } from "./ai-budget.js";
const api = createClient();
export function AdminOverview() {
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
  async function saveBudget(input: Parameters<typeof api.setAiBudget>[0]) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.setAiBudget(input);
      setNotice("Денежный бюджет AI сохранён.");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Не удалось сохранить бюджет",
      );
    } finally {
      try {
        await refresh();
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Не удалось обновить сводку",
        );
      } finally {
        setBusy(false);
      }
    }
  }
  async function refresh() {
    try {
      const [overview, ai] = await Promise.all([api.admin(), api.aiControl()]);
      setData(overview);
      setControl(ai);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setData(null);
      setControl(null);
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
            setBusy(true);
            setError("");
            setNotice("");
            void refresh()
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
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
            setBusy(true);
            setError("");
            setNotice("");
            void (async () => {
              try {
                await api.setAiRouting(input);
                setNotice("Настройка AI сохранена.");
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "Не удалось изменить настройку AI",
                );
              } finally {
                try {
                  await refresh();
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Не удалось обновить сводку",
                  );
                } finally {
                  setBusy(false);
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
    </main>
  );
}

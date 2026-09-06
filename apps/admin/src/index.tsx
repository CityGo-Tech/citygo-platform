"use client";
import { useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card } from "@citygo/ui-web";
const api = createClient();
export function AdminOverview() {
  const [data, setData] = useState<Awaited<
      ReturnType<typeof api.admin>
    > | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
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
            void api
              .admin()
              .then(setData)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          Обновить сводку
        </Button>
        {error && <p role="alert">{error}</p>}
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
    </main>
  );
}

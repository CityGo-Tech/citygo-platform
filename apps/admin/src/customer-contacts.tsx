"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  createSessionGuard,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import type { AdminPhoneContactsPage } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";

export function CustomerContactsControl({
  viewerId,
  onAccessLost,
}: {
  viewerId: string;
  onAccessLost: () => void;
}) {
  const [guard] = useState(createSessionGuard);
  const [page, setPage] = useState<AdminPhoneContactsPage | null>(null);
  const [after, setAfter] = useState<string | undefined>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef<object | null>(null);
  const api = useMemo(
    () =>
      createClient("/api", {
        signal: () => guard.capture().signal,
        onUnauthorized: () => deny(),
      }),
    [guard],
  );
  function invalidate() {
    guard.reset();
    running.current = null;
    setPage(null);
    setAfter(undefined);
    setPrevious([]);
    setBusy(false);
    setError("");
  }
  function deny() {
    invalidate();
    onAccessLost();
  }
  useEffect(() => {
    const unsubscribe = subscribeBrowserSessionChange(invalidate);
    const hidden = () => {
      if (document.visibilityState === "hidden") invalidate();
    };
    window.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", hidden);
      guard.reset();
      running.current = null;
    };
  }, [guard]);

  async function load(cursor?: string, history: (string | undefined)[] = []) {
    if (running.current) return;
    invalidate();
    const ticket = guard.capture();
    const operation = {};
    running.current = operation;
    setBusy(true);
    try {
      const dashboard = await api.dashboard();
      ticket.check();
      if (
        dashboard.user.id !== viewerId ||
        dashboard.user.role !== "super_admin" ||
        dashboard.user.mustChangePassword
      ) {
        deny();
        return;
      }
      const result = await api.adminPhoneContacts(
        cursor ? { afterUserId: cursor } : {},
      );
      ticket.check();
      setPage(result);
      setAfter(cursor);
      setPrevious(history);
    } catch (failure) {
      if (ticket.active()) {
        if (failure instanceof ApiError && failure.status === 403) deny();
        else setError("Не удалось загрузить клиентскую базу. Повторите позже.");
      }
    } finally {
      if (running.current === operation) running.current = null;
      if (ticket.active()) setBusy(false);
    }
  }

  return (
    <Card>
      <h2>Клиентская база</h2>
      <p>
        Подтверждённые телефоны, сохранённые после включения клиентской базы.
      </p>
      <Button disabled={busy} onClick={() => void load()}>
        {page ? "Обновить клиентскую базу" : "Показать клиентскую базу"}
      </Button>
      {(page || busy) && <Button onClick={invalidate}>Скрыть номера</Button>}
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Загрузка клиентской базы…</p>}
      {page && (
        <>
          {page.contacts.length ? (
            <ul aria-label="Подтверждённые телефоны клиентов">
              {page.contacts.map((contact) => (
                <li key={contact.userId}>
                  <h3>{contact.username ?? contact.email}</h3>
                  <p>
                    ID {contact.userId} · {contact.email}
                  </p>
                  <p>{contact.phone}</p>
                  <p>
                    Подтверждён{" "}
                    {new Date(contact.verifiedAt).toLocaleString("ru-RU")}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>Сохранённых номеров пока нет.</p>
          )}
          {previous.length > 0 && (
            <Button
              disabled={busy}
              onClick={() => void load(previous.at(-1), previous.slice(0, -1))}
            >
              Предыдущие телефоны
            </Button>
          )}
          {page.nextAfterUserId !== null && (
            <Button
              disabled={busy}
              onClick={() =>
                void load(page.nextAfterUserId!, [...previous, after])
              }
            >
              Следующие телефоны
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

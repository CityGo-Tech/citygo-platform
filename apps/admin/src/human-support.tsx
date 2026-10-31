"use client";
import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  createClient,
  subscribeBrowserSessionChange,
} from "@citygo/api-client";
import type { AdminSupportRequest } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { SupportReplies } from "./support-replies.js";

export function HumanSupportInbox({
  viewerId,
  sessionSignal,
  onAccessLost,
}: {
  viewerId: string;
  sessionSignal: AbortSignal;
  onAccessLost: () => void;
}) {
  const [data, setData] = useState<{
    actorId: string;
    signal: AbortSignal;
    items: AdminSupportRequest[];
    next: string | null;
  } | null>(null);
  const [selected, setSelected] = useState<AdminSupportRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"open" | "closed" | "">("open");
  const operation = useRef<AbortController | null>(null);
  const denied = useRef(onAccessLost);
  useEffect(() => {
    denied.current = onAccessLost;
  }, [onAccessLost]);
  function clear() {
    operation.current?.abort();
    operation.current = null;
    setData(null);
    setSelected(null);
    setError("");
    setBusy(false);
  }
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") clear();
    };
    const unsubscribe = subscribeBrowserSessionChange(clear);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("focus", clear);
    sessionSignal.addEventListener("abort", clear, { once: true });
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("focus", clear);
      sessionSignal.removeEventListener("abort", clear);
      operation.current?.abort();
    };
  }, [sessionSignal]);
  async function run(
    work: (
      api: ReturnType<typeof createClient>,
      active: () => boolean,
    ) => Promise<void>,
  ) {
    if (operation.current || sessionSignal.aborted) return;
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, sessionSignal]);
    operation.current = controller;
    const active = () => !signal.aborted && operation.current === controller;
    const api = createClient("/api", { signal: () => signal });
    setBusy(true);
    setError("");
    try {
      await work(api, active);
    } catch (failure) {
      if (active()) {
        setData(null);
        setSelected(null);
        if (
          failure instanceof ApiError &&
          [401, 403].includes(failure.status)
        ) {
          clear();
          denied.current();
        } else
          setError(
            "Результат не подтверждён. Обновите список перед следующей операцией.",
          );
      }
    } finally {
      if (active()) {
        operation.current = null;
        setBusy(false);
      }
    }
  }
  function check(actorId: string) {
    if (actorId !== viewerId)
      throw new ApiError(401, "Аккаунт изменился", "invalid_response");
  }
  const visible =
    !sessionSignal.aborted &&
    data?.actorId === viewerId &&
    data.signal === sessionSignal
      ? data
      : null;
  const load = (before?: string) =>
    run(async (api, active) => {
      const result = await api.adminSupportRequests({
        ...(status ? { status } : {}),
        ...(before ? { before } : {}),
      });
      if (!active()) return;
      check(result.actorId);
      setData({
        actorId: viewerId,
        signal: sessionSignal,
        items: before
          ? [...(visible?.items ?? []), ...result.requests]
          : result.requests,
        next: result.nextBefore,
      });
      setSelected(null);
    });
  return (
    <Card
      className="ym-hide-content ym-disable-keys"
      data-citygo-private
      aria-labelledby="human-support-inbox-heading"
      aria-busy={busy}
    >
      <h2 id="human-support-inbox-heading">Обращения к человеку</h2>
      <p>
        Вопросы пользователей владельцу CityGo. Изменение статуса не отправляет
        уведомление или ответ.
      </p>
      <label>
        Статус обращений{" "}
        <select
          value={status}
          disabled={busy}
          onChange={(e) => {
            clear();
            setStatus(e.target.value as typeof status);
          }}
        >
          <option value="open">Открытые</option>
          <option value="closed">Закрытые</option>
          <option value="">Все</option>
        </select>
      </label>{" "}
      <Button disabled={busy} onClick={() => void load()}>
        Обновить обращения пользователей
      </Button>{" "}
      <Button variant="secondary" onClick={clear}>
        Скрыть обращения
      </Button>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Загружаем обращения…</p>}
      {visible && visible.items.length === 0 && (
        <p>Обращений с этим статусом нет.</p>
      )}
      <ul>
        {visible?.items.map((item) => (
          <li key={item.id}>
            <h3>
              Обращение №{item.id} ·{" "}
              {item.status === "closed" ? "Закрыто" : "Открыто"}
            </h3>
            <p>
              Аккаунт {item.owner.userId} ·{" "}
              {item.owner.email ?? item.owner.username ?? "Почта не указана"}
            </p>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {item.body}
            </p>
            <p>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString("ru-RU")}
              </time>
            </p>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async (api, active) => {
                  const result = await api.adminSupportRequest(item.id);
                  if (!active()) return;
                  check(result.actorId);
                  setSelected(result.request);
                })
              }
            >
              Открыть обращение №{item.id}
            </Button>
          </li>
        ))}
      </ul>
      {visible?.next && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void load(visible.next!)}
        >
          Ещё обращения пользователей
        </Button>
      )}
      {visible && selected && (
        <section aria-label={"Карточка обращения №" + selected.id}>
          <h3>Карточка обращения №{selected.id}</h3>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {selected.body}
          </p>
          <p>
            Статус: {selected.status === "closed" ? "Закрыто" : "Открыто"} ·
            Версия {selected.revision}
          </p>
          <SupportReplies
            key={viewerId + ":" + selected.id}
            viewerId={viewerId}
            requestId={selected.id}
            sessionSignal={sessionSignal}
            onAccessDenied={() => {
              clear();
              denied.current();
            }}
            admin
            revision={selected.revision}
            requestClosed={selected.status === "closed"}
            onReplied={(result) => {
              check(result.actorId);
              setSelected(result.request);
              setData((current) =>
                current
                  ? {
                      ...current,
                      items: current.items.map((item) =>
                        item.id === result.request.id ? result.request : item,
                      ),
                    }
                  : null,
              );
            }}
          />
          <Button
            disabled={busy}
            onClick={() =>
              void run(async (api, active) => {
                const result = await api.setSupportRequestStatus(selected.id, {
                  expectedRevision: selected.revision,
                  status: selected.status === "open" ? "closed" : "open",
                });
                if (!active()) return;
                check(result.actorId);
                setSelected(result.request);
                setData((current) =>
                  current
                    ? {
                        ...current,
                        items: current.items
                          .map((item) =>
                            item.id === result.request.id
                              ? result.request
                              : item,
                          )
                          .filter((item) => !status || item.status === status),
                      }
                    : null,
                );
              })
            }
          >
            {selected.status === "open"
              ? "Закрыть обращение"
              : "Открыть обращение снова"}
          </Button>
        </section>
      )}
    </Card>
  );
}

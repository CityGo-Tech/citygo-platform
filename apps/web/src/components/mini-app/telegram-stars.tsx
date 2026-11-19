"use client";

import { createClient } from "@citygo/api-client";
import type {
  TelegramStarsOrder,
  TelegramStarsSnapshot,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { OpenMiniAppInvoice } from "./host";
import styles from "./telegram-stars.module.css";

type StarsView = {
  snapshot: TelegramStarsSnapshot | null;
  refreshing: boolean;
  working: boolean;
  invoiceOpen: boolean;
  readError: boolean;
  actionError: string;
};

const initialView: StarsView = {
  snapshot: null,
  refreshing: false,
  working: false,
  invoiceOpen: false,
  readError: false,
  actionError: "",
};

const statuses: Record<TelegramStarsOrder["status"], string> = {
  pending: "Ожидает оплаты",
  checkout: "Оплата обрабатывается",
  paid: "Оплачен",
  cancelled: "Отменён",
  refunded: "Возвращён",
};

function createStarsResource({
  client,
  openInvoice,
  signal,
  onChange,
}: {
  client: ReturnType<typeof createClient>;
  openInvoice: OpenMiniAppInvoice;
  signal: AbortSignal;
  onChange: (view: StarsView) => void;
}) {
  let view = initialView;
  let readVersion = 0;
  let requestId: string | undefined;
  let invoiceId: string | undefined;

  function publish(patch: Partial<StarsView>) {
    if (signal.aborted) return;
    view = { ...view, ...patch };
    onChange(view);
  }

  async function refresh() {
    if (signal.aborted) return;
    const version = ++readVersion;
    publish({ refreshing: true, readError: false });
    try {
      const snapshot = await client.telegramStars();
      if (version === readVersion) publish({ snapshot, refreshing: false });
    } catch {
      if (version === readVersion)
        publish({ refreshing: false, readError: true });
    }
  }

  async function mutate<T>(operation: () => Promise<T>, actionError: string) {
    if (signal.aborted || view.working || view.invoiceOpen) return;
    publish({ working: true, actionError: "" });
    try {
      return await operation();
    } catch {
      publish({ actionError });
    } finally {
      publish({ working: false });
    }
  }

  async function cancel(id: string) {
    await mutate(
      () => client.cancelTelegramStarsOrder(id),
      "Не удалось отменить заказ. Проверьте его статус.",
    );
    await refresh();
  }

  async function refund(id: string) {
    await mutate(
      () => client.refundTelegramStarsOrder(id),
      "Не удалось подтвердить возврат. Проверьте статус заказа.",
    );
    await refresh();
  }

  async function pay() {
    const result = await mutate(
      () =>
        client.createTelegramStarsOrder((requestId ??= crypto.randomUUID())),
      "Создание заказа не подтверждено. Повторите попытку или обновите статус.",
    );
    if (!result || signal.aborted) return;
    requestId = undefined;
    if (result.order.status === "pending") {
      const id = result.order.id;
      invoiceId = id;
      publish({ invoiceOpen: true });
      try {
        openInvoice(result.invoiceUrl, (status) => {
          if (signal.aborted || invoiceId !== id) return;
          invoiceId = undefined;
          publish({ invoiceOpen: false });
          if (status === "cancelled") void cancel(id);
          else void refresh();
        });
      } catch {
        invoiceId = undefined;
        publish({
          invoiceOpen: false,
          actionError: "Не удалось открыть тестовый счёт в Telegram.",
        });
      }
    }
    await refresh();
  }

  return { refresh, pay, cancel, refund };
}

export function TelegramStarsPanel({
  sessionSignal,
  openInvoice,
  onAccessDenied,
  onClose,
}: {
  sessionSignal: AbortSignal;
  openInvoice: OpenMiniAppInvoice;
  onAccessDenied: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<{
    session: AbortSignal;
    view: StarsView;
  } | null>(null);
  const resource = useRef<ReturnType<typeof createStarsResource> | null>(null);
  const denied = useRef(onAccessDenied);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    denied.current = onAccessDenied;
  }, [onAccessDenied]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    const current = createStarsResource({
      signal,
      openInvoice,
      client: createClient("/api", {
        signal: () => signal,
        onUnauthorized: () => {
          if (!signal.aborted) denied.current();
        },
      }),
      onChange: (view) => setState({ session: sessionSignal, view }),
    });
    resource.current = current;
    heading.current?.focus();
    void current.refresh();
    return () => {
      controller.abort();
      if (resource.current === current) resource.current = null;
    };
  }, [sessionSignal, openInvoice]);
  if (sessionSignal.aborted) return null;
  const view = state?.session === sessionSignal ? state.view : initialView;
  const snapshot = view.snapshot;
  const changing = view.working || view.invoiceOpen;
  return (
    <section
      className={`${styles.panel} ym-hide-content ym-disable-keys`}
      data-citygo-analytics-private
      data-citygo-private
      aria-labelledby="telegram-stars-heading"
    >
      <h1 id="telegram-stars-heading" ref={heading} tabIndex={-1}>
        Тестовая оплата Stars
      </h1>
      <Card className={styles.summary}>
        <strong>1 Star</strong>
        <p>Тестовая покупка даёт одну тестовую единицу.</p>
        {snapshot && <p>Тестовые единицы: {snapshot.balance}</p>}
        <Button
          disabled={!snapshot || changing || view.readError}
          onClick={() => void resource.current?.pay()}
        >
          Оплатить 1 Star
        </Button>
      </Card>
      <Button
        variant="secondary"
        disabled={view.refreshing}
        onClick={() => void resource.current?.refresh()}
      >
        Обновить статус
      </Button>
      {view.refreshing && <p role="status">Проверяем статус…</p>}
      {view.readError && (
        <p role="alert">Не удалось загрузить статус тестовой оплаты.</p>
      )}
      {view.actionError && <p role="alert">{view.actionError}</p>}
      {snapshot && (
        <section aria-labelledby="telegram-stars-orders-heading">
          <h2 id="telegram-stars-orders-heading">Тестовые заказы</h2>
          {snapshot.orders.length === 0 ? (
            <p>Тестовых заказов пока нет.</p>
          ) : (
            <ul className={styles.orders}>
              {snapshot.orders.map((order) => (
                <li key={order.id} className={styles.order}>
                  <strong>{statuses[order.status]}</strong>
                  <p className={styles.reference}>Заказ №{order.id}</p>
                  <time dateTime={order.createdAt}>
                    {new Date(order.createdAt).toLocaleString("ru-RU")}
                  </time>
                  {order.status === "pending" && (
                    <Button
                      variant="secondary"
                      disabled={changing || view.readError}
                      onClick={() => void resource.current?.cancel(order.id)}
                    >
                      Отменить тестовый заказ
                    </Button>
                  )}
                  {order.status === "paid" && (
                    <Button
                      variant="secondary"
                      disabled={changing || view.readError}
                      onClick={() => void resource.current?.refund(order.id)}
                    >
                      Запросить тестовый возврат
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Button variant="secondary" onClick={onClose}>
        К профилю
      </Button>
    </section>
  );
}

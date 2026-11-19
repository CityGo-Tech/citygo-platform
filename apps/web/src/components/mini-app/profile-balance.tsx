"use client";

import { createClient } from "@citygo/api-client";
import { formatSignedMoneyMicros } from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import { useEffect, useState } from "react";
import { BalanceHistoryPanel } from "../balance-history";
import { MaxTestTopupPanel } from "./max-test-topup";
import styles from "./profile-balance.module.css";

type MaxTopupList = Awaited<
  ReturnType<ReturnType<typeof createClient>["listMaxTopups"]>
>;

export function MiniAppProfileBalance({
  userId,
  sessionSignal,
  availableMicros,
  onAccessDenied,
  openMaxPayment,
  onBalanceChanged,
  onClose,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  availableMicros: number | undefined;
  onAccessDenied: () => void;
  openMaxPayment?: (url: string) => void;
  onBalanceChanged: () => void;
  onClose: () => void;
}) {
  const [capability, setCapability] = useState<{
    owner: string;
    session: AbortSignal;
    list: MaxTopupList;
  } | null>(null);
  const [expanded, setExpanded] = useState<AbortSignal | null>(null);
  useEffect(() => {
    if (!openMaxPayment) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, sessionSignal]);
    void createClient("/api", { signal: () => signal })
      .listMaxTopups()
      .then((list) => {
        if (!signal.aborted && list.orders.every((order) => order.test))
          setCapability({ owner: userId, session: sessionSignal, list });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [openMaxPayment, sessionSignal, userId]);
  if (sessionSignal.aborted) return null;
  const maxTopups =
    openMaxPayment &&
    capability?.owner === userId &&
    capability.session === sessionSignal
      ? capability.list
      : undefined;
  return (
    <section
      id="citygo-wallet-view"
      className={`${styles.wallet} ym-hide-content`}
      tabIndex={-1}
      aria-labelledby="mini-wallet-heading"
      data-citygo-analytics-private
    >
      <h1 id="mini-wallet-heading">Баланс CityGo</h1>
      <div className={styles.total}>
        <span>Доступно</span>
        <strong>
          {availableMicros === undefined
            ? "Баланс недоступен"
            : `${formatSignedMoneyMicros(availableMicros)} ₽`}
        </strong>
        {!maxTopups && <span>Пополнение здесь недоступно</span>}
      </div>
      {maxTopups &&
        openMaxPayment &&
        (expanded === sessionSignal ? (
          <MaxTestTopupPanel
            key={userId}
            sessionSignal={sessionSignal}
            initialOrders={maxTopups.orders}
            openPayment={openMaxPayment}
            onAccessDenied={onAccessDenied}
            onBalanceChanged={onBalanceChanged}
          />
        ) : (
          <Button type="button" onClick={() => setExpanded(sessionSignal)}>
            Тестовое пополнение
          </Button>
        ))}
      <BalanceHistoryPanel
        userId={userId}
        sessionSignal={sessionSignal}
        onAccessDenied={onAccessDenied}
      />
      <Button type="button" variant="secondary" onClick={onClose}>
        К профилю
      </Button>
    </section>
  );
}

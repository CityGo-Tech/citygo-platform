"use client";

import { formatSignedMoneyMicros } from "@citygo/contracts";
import { Button } from "@citygo/ui-web";
import { BalanceHistoryPanel } from "../balance-history";
import styles from "./profile-balance.module.css";

export function MiniAppProfileBalance({
  userId,
  sessionSignal,
  availableMicros,
  onAccessDenied,
  onClose,
}: {
  userId: string;
  sessionSignal: AbortSignal;
  availableMicros: number | undefined;
  onAccessDenied: () => void;
  onClose: () => void;
}) {
  if (sessionSignal.aborted) return null;
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
        <span>Пополнение здесь недоступно</span>
      </div>
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

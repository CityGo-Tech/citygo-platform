"use client";
import { formatSignedMoneyMicros, type AiAccess } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { useRef } from "react";
import styles from "./account-overview.module.css";

/** Account-level entry points, available before the first conversation. */
export function AccountOverview({
  access,
  disabled,
  onBalance,
  onPhone,
  compact = false,
}: {
  access: AiAccess;
  disabled: boolean;
  onBalance: () => void;
  onPhone: () => void;
  compact?: boolean;
}) {
  const compactMenu = useRef<HTMLDetailsElement>(null);
  const closeCompactMenu = () => {
    if (compactMenu.current) compactMenu.current.open = false;
  };
  if (compact) {
    return (
      <Card
        id="citygo-account-overview"
        className={styles.overview + " " + styles.compact + " ym-hide-content"}
        aria-label="Баланс и телефон"
      >
        <Button
          className={styles.compactBalance}
          variant="secondary"
          disabled={disabled}
          aria-label="Баланс и пополнение"
          onClick={() => {
            closeCompactMenu();
            onBalance();
          }}
        >
          {access.credit
            ? `${formatSignedMoneyMicros(access.credit.availableMicros)} ₽`
            : "Баланс недоступен"}
        </Button>
        <details
          ref={compactMenu}
          className={styles.compactMenu}
          onKeyDown={(event) => {
            if (event.key === "Escape" && compactMenu.current?.open) {
              event.preventDefault();
              closeCompactMenu();
              compactMenu.current?.querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label="Действия с балансом">Ещё</summary>
          <div className={styles.compactActions}>
            <Button
              className="ym-show-content"
              disabled={disabled}
              onClick={() => {
                closeCompactMenu();
                onBalance();
              }}
            >
              Пополнить баланс
            </Button>
            <Button
              className="ym-show-content"
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                closeCompactMenu();
                onPhone();
              }}
            >
              Телефон и подарок
            </Button>
            <small>
              {access.credit?.bonusGranted
                ? "Подарок уже начислен."
                : "500 ₽ в подарок за подтверждение телефона."}
            </small>
          </div>
        </details>
      </Card>
    );
  }
  return (
    <Card
      id="citygo-account-overview"
      className={styles.overview}
      aria-label="Баланс и телефон"
    >
      <div>
        <span className={styles.eyebrow}>БАЛАНС CITYGO</span>
        <div className={styles.amount}>
          {access.credit
            ? `${formatSignedMoneyMicros(access.credit.availableMicros)} ₽ CityGo`
            : "Баланс недоступен"}
        </div>
        <p>Для общения с помощниками</p>
        <Button
          className="ym-show-content"
          variant="ghost"
          disabled={disabled}
          onClick={onBalance}
        >
          Баланс и пополнение
        </Button>
      </div>
      <div className={styles.actions}>
        <Button
          className="ym-show-content"
          disabled={disabled}
          onClick={onBalance}
        >
          Пополнить баланс
        </Button>
        <Button
          className="ym-show-content"
          variant="secondary"
          disabled={disabled}
          onClick={onPhone}
        >
          Телефон и подарок
        </Button>
        <small>
          {access.credit?.bonusGranted
            ? "Подарок уже начислен."
            : "500 ₽ в подарок за подтверждение телефона."}
        </small>
      </div>
    </Card>
  );
}

export { styles as accountStyles };

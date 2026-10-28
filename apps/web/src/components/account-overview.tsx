"use client";
import { formatSignedMoneyMicros, type AiAccess } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import styles from "./account-overview.module.css";

/** Account-level entry points, available before the first conversation. */
export function AccountOverview({
  access,
  disabled,
  onBalance,
  onPhone,
}: {
  access: AiAccess;
  disabled: boolean;
  onBalance: () => void;
  onPhone: () => void;
}) {
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

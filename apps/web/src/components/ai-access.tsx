"use client";
import * as React from "react";
import { formatSignedMoneyMicros, type AiAccess } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { TestTopupPanel, type TopupActions } from "./test-topup";
import { chatBalanceTarget } from "./chat-readiness";

export function AiAccessPanel({
  access,
  busy,
  userId,
  topups,
  onPhone,
  renderHistory,
}: {
  access: AiAccess;
  busy: boolean;
  userId?: string;
  topups?: TopupActions;
  onPhone?: () => void;
  renderHistory?: (onClose: () => void) => React.ReactNode;
}) {
  const citygoTariff = access.credit?.chargingStatus === "routerai_citygo_10x";
  const [historyOpen, setHistoryOpen] = React.useState(false);
  if (historyOpen && renderHistory)
    return (
      <Card className="ai-access">
        {renderHistory(() => setHistoryOpen(false))}
      </Card>
    );
  return (
    <Card className="ai-access">
      {access.credit && (
        <section
          id={chatBalanceTarget}
          tabIndex={-1}
          aria-label={citygoTariff ? "Баланс CityGo" : "Бесплатный баланс AI"}
        >
          <strong className="balance-amount">
            {formatSignedMoneyMicros(access.credit.availableMicros)} ₽
            {citygoTariff ? " CityGo" : ""}
          </strong>
          {(access.credit.outstandingDebtMicros ?? 0) > 0 && (
            <p role="status">
              Задолженность:{" "}
              {formatSignedMoneyMicros(access.credit.outstandingDebtMicros!)} ₽
              CityGo. Пополнение сначала погасит её.
            </p>
          )}
          {userId && topups && (
            <TestTopupPanel
              key={userId}
              userId={userId}
              actions={topups}
              disabled={busy}
              canCreate={access.credit.topUpAvailable === true}
            />
          )}
          {!access.credit.topUpAvailable && (
            <p>Пополнение временно недоступно.</p>
          )}
          {access.credit.reservationMode === "fixed5_overdraft" && (
            <p>
              Ответы помощников оплачиваются с баланса. Если стоимость ответа
              превысит остаток, баланс может стать отрицательным.
            </p>
          )}
          {access.credit.bonusGranted ? (
            <p>Подарок 500 ₽ уже начислен.</p>
          ) : (
            onPhone && (
              <Button type="button" variant="secondary" onClick={onPhone}>
                Получить подарок 500 ₽
              </Button>
            )
          )}
          {!!access.credit.pending?.length && (
            <p role="status">
              Некоторые операции ещё обрабатываются. Баланс обновится после
              проверки.
            </p>
          )}
          {renderHistory && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setHistoryOpen(true)}
            >
              История баланса
            </Button>
          )}
        </section>
      )}
    </Card>
  );
}

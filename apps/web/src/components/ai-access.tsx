"use client";
import * as React from "react";
import {
  formatMoneyMicros,
  formatSignedMoneyMicros,
  type AiAccess,
  type AiConsentInput,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";
import { TestTopupPanel, type TopupActions } from "./test-topup";
import { chatBalanceTarget } from "./chat-readiness";

export function AiAccessPanel({
  access,
  busy,
  onConsent,
  userId,
  topups,
  balanceOnly = false,
  onBalance,
  onPhone,
}: {
  access: AiAccess;
  busy: boolean;
  onConsent: (input: AiConsentInput) => void;
  userId?: string;
  topups?: TopupActions;
  balanceOnly?: boolean;
  onBalance?: () => void;
  onPhone?: () => void;
}) {
  const [checked, setChecked] = React.useState(false);
  const policy = access.policy;
  const citygoTariff = access.credit?.chargingStatus === "routerai_citygo_10x";
  const operations =
    access.credit?.history.filter((entry) =>
      ["bonus", "topup", "settle"].includes(entry.kind),
    ) ?? [];
  // Keep the accepted processing terms available next to explicit consent.
  // Internal model prices, reserves and routing controls are not account UI.
  const terms = policy && (
    <>
      <p>Обработку выполняет {policy.recipient}.</p>
      <p>{policy.routing}</p>
      <p>{policy.data}</p>
    </>
  );
  return (
    <Card className="ai-access">
      {onBalance && access.credit && (
        <Button type="button" variant="secondary" onClick={onBalance}>
          Баланс и пополнение
        </Button>
      )}
      {!onBalance && access.credit && (
        <section
          id={chatBalanceTarget}
          tabIndex={-1}
          aria-label={citygoTariff ? "Баланс CityGo" : "Бесплатный баланс AI"}
        >
          {!balanceOnly && (
            <h2>{citygoTariff ? "Баланс CityGo" : "Бесплатный баланс AI"}</h2>
          )}
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
          {operations.length > 0 && (
            <details>
              <summary>Последние операции</summary>
              <ul>
                {operations.map((entry) => (
                  <li key={entry.id}>
                    {
                      {
                        bonus: "Подарок",
                        topup: "Пополнение",
                        settle: "Общение с помощником",
                        hold: "",
                        release: "",
                      }[entry.kind]
                    }
                    : {formatMoneyMicros(entry.amountMicros)} ₽ ·{" "}
                    {new Date(entry.createdAt).toLocaleString("ru-RU", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {!balanceOnly &&
        (access.granted ? (
          <details>
            <summary>Настройки обработки сообщений</summary>
            {terms}
            <p>
              После отзыва согласия новые ответы будут недоступны. История
              сохранится.
            </p>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onConsent({ action: "revoked" })}
            >
              Отозвать согласие
            </Button>
          </details>
        ) : (
          <>
            <h2>Перед началом</h2>
            {policy ? (
              <>
                <details>
                  <summary>Условия обработки сообщений</summary>
                  {terms}
                </details>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={(event) => setChecked(event.target.checked)}
                  />
                  <span>
                    Согласен на обработку сообщений для ответов помощника.
                  </span>
                </label>
                <Button
                  type="button"
                  disabled={busy || !checked}
                  onClick={() =>
                    onConsent({ action: "granted", policyId: policy.id })
                  }
                >
                  Продолжить
                </Button>
              </>
            ) : (
              <p>Помощник временно недоступен. Попробуйте позже.</p>
            )}
          </>
        ))}
    </Card>
  );
}

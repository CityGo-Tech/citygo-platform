"use client";
import * as React from "react";
import {
  formatMoneyMicros,
  formatSignedMoneyMicros,
  formatMoneyCounterMicros,
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
  const description = policy && (
    <>
      <p>
        Получатель: {policy.recipient}. Модель: {policy.model}.
      </p>
      <p>{policy.routing}</p>
      <p>{policy.data}</p>
      <p>
        До {access.dailyLimit} принятых запросов чата в сутки (UTC). Возможен
        общий лимит сервиса. Автоматического переключения нет.
      </p>
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
          <h2>{citygoTariff ? "Баланс CityGo" : "Бесплатный баланс AI"}</h2>
          <strong className="balance-amount">
            {formatSignedMoneyMicros(access.credit.availableMicros)} ₽
            {citygoTariff ? " CityGo" : ""}
          </strong>
          {userId && topups && (
            <TestTopupPanel
              key={userId}
              userId={userId}
              actions={topups}
              disabled={busy}
              canCreate={access.credit.topUpAvailable === true}
            />
          )}
          <p>
            {access.credit.bonusGranted
              ? "Разовые 500 ₽ начислены. Ежедневного восстановления нет."
              : citygoTariff
                ? "Подарок 500 ₽ CityGo выдаётся один раз после подтверждения телефона. Доступность и условия проверяются в разделе «Телефон и подарок»."
                : "Разовый бонус 500 ₽ ещё не выдан. Обратитесь к владельцу пилота."}
          </p>
          {onPhone && (
            <Button type="button" variant="secondary" onClick={onPhone}>
              Телефон и подарок
            </Button>
          )}
          <p>
            Доступно: {formatSignedMoneyMicros(access.credit.availableMicros)}{" "}
            ₽. В резерве: {formatMoneyMicros(access.credit.heldMicros)} ₽.
            Учтено списаний: {formatMoneyMicros(access.credit.spentMicros)} ₽.
          </p>
          {access.credit.reservationMode === "fixed5_overdraft" && (
            <p role="note">
              Перед платным запросом резервируется 5 ₽ CityGo. Это не итоговая
              цена: спишется полная подтверждённая стоимость модели ×10. Если
              средств не хватит, баланс станет отрицательным. Новые платные
              запросы доступны после пополнения до 5 ₽ свободного баланса;
              пополнение сначала погашает задолженность.
            </p>
          )}
          {(access.credit.outstandingDebtMicros ?? 0) > 0 && (
            <p role="status">
              Задолженность:{" "}
              {formatSignedMoneyMicros(access.credit.outstandingDebtMicros!)} ₽
              CityGo. Она будет погашена из следующих пополнений.
            </p>
          )}
          <p>
            {citygoTariff
              ? access.credit.reservationMode === "fixed5_overdraft"
                ? "Расход модели 1 ₽ соответствует списанию 10 ₽ CityGo. Оплата 100 ₽ пополняет баланс на 100 ₽ CityGo. Неизвестная стоимость остаётся на сверке; её нельзя считать нулевой."
                : "Расход модели 1 ₽ соответствует списанию 10 ₽ CityGo. Оплата 100 ₽ пополняет баланс на 100 ₽ CityGo. Перед запросом резервируется верхняя оценка; неизвестная стоимость остаётся на сверке."
              : access.credit.chargingStatus === "routerai_at_cost"
                ? "Ответы RouterAI — по подтверждённой стоимости без наценки. Перед запросом сумма резервируется; при неизвестной стоимости резерв остаётся на сверке. Доли микрорубля округляются вниз."
                : "Автоматическое списание за ответы пока не подключено."}{" "}
            {access.credit.topUpAvailable === true
              ? "Пополнение доступно. Перед оплатой проверьте режим платежа."
              : "Пополнение пока недоступно."}{" "}
            Бонус не включает ИИ и не заменяет общий бюджет сервиса.
          </p>
          {!!access.credit.pending?.length && (
            <div role="status">
              <p>Резервы на сверке. При обращении к владельцу укажите ID:</p>
              <ul>
                {access.credit.pending.map((item) => (
                  <li key={item.holdId}>
                    {item.holdId}: {formatMoneyMicros(item.amountMicros)} ₽ —{" "}
                    {item.responseComplete
                      ? "ответ сохранён, уточняется стоимость"
                      : "результат запроса не подтверждён"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!access.credit.history.length && (
            <details>
              <summary>Последние операции баланса (до 20)</summary>
              <ul>
                {access.credit.history.map((entry) => (
                  <li key={entry.id}>
                    {
                      {
                        bonus: "Разовый бонус",
                        topup: "Пополнение",
                        hold: "Резерв",
                        settle: "Списание",
                        release: "Освобождение резерва",
                      }[entry.kind]
                    }
                    {entry.kind === "release"
                      ? " без списания"
                      : `: ${formatMoneyMicros(entry.amountMicros)} ₽`}{" "}
                    · {entry.createdAt}
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
            <summary>
              Передача данных разрешена: {policy?.recipient} · {policy?.model}
            </summary>
            {description}
          </details>
        ) : (
          <>
            <h2>Передача данных AI</h2>
            {description ?? (
              <p>
                Условия подключения недоступны. Обновите страницу перед
                отправкой сообщения.
              </p>
            )}
            {policy && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                <span>
                  Разрешаю передачу указанных данных этому получателю для
                  рекомендаций.
                </span>
              </label>
            )}
            {policy && (
              <Button
                type="button"
                disabled={busy || !checked}
                onClick={() =>
                  onConsent({ action: "granted", policyId: policy.id })
                }
              >
                Подтвердить получателя AI
              </Button>
            )}
          </>
        ))}
      {!onBalance && access.budget?.limitMicros != null && (
        <p role="status">
          Лимит AI вашего аккаунта:{" "}
          {formatMoneyMicros(access.budget.limitMicros)}{" "}
          {access.budget.currency ?? "(валюта не выбрана)"} в сутки.
          Зарезервировано:{" "}
          {formatMoneyCounterMicros(access.budget.reservedTodayMicros)}. Остаток
          резерва: {formatMoneyMicros(access.budget.remainingMicros ?? 0)}.
          Обновление в 00:00 UTC (03:00 по Москве). Это резерв, не фактическое
          списание провайдера; общий бюджет сервиса также может ограничить
          отправку.
        </p>
      )}
      {!balanceOnly && (
        <>
          <p>
            <small>
              Отзыв блокирует новые запросы. Уже принятый запрос может
              завершиться; переданные данные нельзя вернуть. План и история
              остаются доступны.
            </small>
          </p>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onConsent({ action: "revoked" })}
          >
            Отозвать разрешение AI
          </Button>
        </>
      )}
    </Card>
  );
}

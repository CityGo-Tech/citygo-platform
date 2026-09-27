"use client";
import { useState } from "react";
import {
  aiCreditGrantSchema,
  aiCreditReconcileSchema,
  type AiCreditGrant,
  type AiCreditReconcile,
} from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";

export function AiCreditControls({
  busy,
  onGrant,
  onReconcile,
}: {
  busy: boolean;
  onGrant: (input: AiCreditGrant) => void;
  onReconcile: (input: AiCreditReconcile) => void;
}) {
  const [userId, setUserId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [holdId, setHoldId] = useState("");
  const [reconcileConfirmed, setReconcileConfirmed] = useState(false);
  const reconcile = aiCreditReconcileSchema.safeParse({
    userId,
    holdId,
    confirmReconcile: reconcileConfirmed,
  });
  const input = aiCreditGrantSchema.safeParse({
    userId,
    confirmOneTime500Rub: confirmed,
  });
  return (
    <Card>
      <h2>Разовый бесплатный баланс</h2>
      <p>
        500 ₽ один раз на аккаунт, без ежедневного восстановления. Повторное
        подтверждение не начислит бонус заново.
      </p>
      <p>
        Проверьте ID вместе с участником: он указан в его блоке баланса. Разные
        аккаунты одного человека пока не определяются автоматически.
      </p>
      <label>
        ID аккаунта участника
        <input
          inputMode="numeric"
          value={userId}
          disabled={busy}
          onChange={(event) => {
            setUserId(event.target.value.trim());
            setConfirmed(false);
            setReconcileConfirmed(false);
          }}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || !userId}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        Подтверждаю выдачу разовых 500 ₽ аккаунту {userId || "…"}
      </label>
      <Button
        disabled={busy || !input.success}
        onClick={() => {
          if (input.success) onGrant(input.data);
        }}
      >
        Подтвердить разовый бонус
      </Button>
      <p>
        Это бесплатный бонус, не платёж. Списание RouterAI по себестоимости
        требует отдельного включения на сервере. Пополнение недоступно; бонус не
        включает ИИ и не увеличивает общий бюджет оператора.
      </p>
      <h3>Сверка стоимости сохранённого ответа</h3>
      <p>
        Скопируйте ID резерва из баланса участника. Проверяется только
        детализация уже завершённого запроса: нового вызова модели и
        произвольного изменения суммы нет. Прерванные ответы требуют отдельной
        ручной проверки.
      </p>
      <label>
        ID резерва для сверки
        <input
          value={holdId}
          disabled={busy}
          onChange={(e) => {
            setHoldId(e.target.value.trim());
            setReconcileConfirmed(false);
          }}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={reconcileConfirmed}
          disabled={busy || !holdId || !userId}
          onChange={(e) => setReconcileConfirmed(e.target.checked)}
        />
        Подтверждаю сверку стоимости для аккаунта {userId || "…"}
      </label>
      <Button
        disabled={busy || !reconcile.success}
        onClick={() => {
          if (reconcile.success) onReconcile(reconcile.data);
        }}
      >
        Сверить стоимость ответа
      </Button>
    </Card>
  );
}

"use client";
import { useState } from "react";
import { aiCreditGrantSchema, type AiCreditGrant } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";

export function AiCreditControls({
  busy,
  onGrant,
}: {
  busy: boolean;
  onGrant: (input: AiCreditGrant) => void;
}) {
  const [userId, setUserId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
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
        Это бесплатный бонус, не платёж. Автоматическое списание за ответы и
        пополнение ещё не подключены; начисление не включает ИИ и не увеличивает
        общий бюджет оператора.
      </p>
    </Card>
  );
}

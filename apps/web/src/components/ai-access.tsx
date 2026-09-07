"use client";
import { useState } from "react";
import type { AiAccess, AiConsentInput } from "@citygo/contracts";
import { Button, Card } from "@citygo/ui-web";

export function AiAccessPanel({
  access,
  busy,
  onConsent,
}: {
  access: AiAccess;
  busy: boolean;
  onConsent: (input: AiConsentInput) => void;
}) {
  const [checked, setChecked] = useState(false);
  const policy = access.policy;
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
      {access.granted ? (
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
              Условия подключения недоступны. Обновите страницу перед отправкой
              сообщения.
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
      )}
      <p>
        <small>
          Отзыв блокирует новые запросы. Уже принятый запрос может завершиться;
          переданные данные нельзя вернуть. План и история остаются доступны.
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
    </Card>
  );
}

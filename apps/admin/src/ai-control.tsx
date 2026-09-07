"use client";
import { useState } from "react";
import { createClient } from "@citygo/api-client";
import { Button, Card } from "@citygo/ui-web";

const api = createClient();
type Status = Awaited<ReturnType<typeof api.aiControl>>;
type Selection = Status["current"]["provider"];
const names = {
  openai: "OpenAI",
  routerai: "RouterAI",
  gigachat: "GigaChat",
  disabled: "Отключён",
};
const reasons = {
  not_configured: "Не настроен или настройки неверны",
  production_blocked: "Пока запрещён в production",
  server_disabled: "Отключён серверной настройкой",
};

export function AiControls({
  status,
  busy,
  onSave,
}: {
  status: Status;
  busy: boolean;
  onSave: (input: Parameters<typeof api.setAiRouting>[0]) => void;
}) {
  const [selected, setSelected] = useState<Selection>(status.current.provider);
  const [confirmed, setConfirmed] = useState(false);
  const option = status.options.find((entry) => entry.provider === selected);
  const policy = option?.policy;
  const available = selected === "disabled" || !!policy;
  const changed =
    selected !== status.current.provider ||
    (policy?.id ?? null) !== status.current.policyId;
  return (
    <Card style={{ marginTop: 20, overflowWrap: "anywhere" }}>
      <h2>Управление AI</h2>
      <p>
        Сохранённый выбор: {names[status.current.provider]}. Версия:{" "}
        {status.current.revision}.
      </p>
      <p>
        Выбран на этом сервере:{" "}
        {status.effectiveProvider === "unconfigured"
          ? "нет"
          : names[status.effectiveProvider]}
        .
      </p>
      {status.environmentDisabled && (
        <p>
          AI отключён через LLM_PROVIDER=disabled. Включение из админки
          недоступно.
        </p>
      )}
      {status.current.provider !== "disabled" &&
        status.effectiveProvider === "unconfigured" &&
        !status.environmentDisabled && (
          <p>
            Сохранённый получатель не совпадает с доступной конфигурацией.
            Проверьте настройки всех серверов; автоматической замены нет.
          </p>
        )}
      <label className="cg-field">
        <span>Активный AI-провайдер</span>
        <select
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value as Selection);
            setConfirmed(false);
          }}
        >
          <option value="disabled">
            Отключён — не принимать новые AI-сообщения
          </option>
          {status.options.map((entry) => (
            <option
              key={entry.provider}
              value={entry.provider}
              disabled={!!entry.unavailableReason}
            >
              {names[entry.provider]}
              {entry.unavailableReason
                ? " · " + reasons[entry.unavailableReason]
                : ""}
            </option>
          ))}
        </select>
      </label>
      {policy && (
        <>
          <p>
            Получатель: {policy.recipient}. Модель: {policy.model}.
          </p>
          <p>{policy.routing}</p>
        </>
      )}
      <p>
        Изменение действует на новые сообщения всех пользователей. Уже принятый
        ответ может завершиться прежним провайдером. История и суточные лимиты
        сохраняются.
      </p>
      <p>
        Пользователь должен отдельно разрешить передачу новому получателю. Выбор
        администратора не заменяет это согласие. Автоматическое резервное
        переключение выключено.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy || !available || !changed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        <span>Подтверждаю изменение провайдера для новых сообщений.</span>
      </label>
      <Button
        disabled={busy || !available || !changed || !confirmed}
        style={{ maxWidth: "100%", whiteSpace: "normal" }}
        onClick={() => {
          if (selected === "disabled")
            onSave({
              provider: "disabled",
              policyId: null,
              expectedRevision: status.current.revision,
            });
          else if (policy)
            onSave({
              provider: selected,
              policyId: policy.id,
              expectedRevision: status.current.revision,
            });
        }}
      >
        Применить настройку AI
      </Button>
      <h3>Последние изменения AI</h3>
      <p>
        Ключи и адреса API здесь не редактируются. Настройка моделей выполняется
        только на сервере.
      </p>
      <p>
        Наличие конфигурации не подтверждает доступ к реальной модели. Проверка
        ключей и платных ответов проводится отдельно.
      </p>
      <ol>
        {status.audit.map((item) => (
          <li key={item.id}>
            {item.payload.from
              ? names[item.payload.from.provider]
              : "Первичная настройка"}{" "}
            → {names[item.payload.to.provider]} · версия{" "}
            {item.payload.to.revision}
            {" · "}
            {item.payload.policy?.model ?? "без модели"}
            {" · "}
            {new Date(item.createdAt).toLocaleString("ru-RU")}
            {" · "}
            {item.actorUserId ? "администратор #" + item.actorUserId : "сервер"}
          </li>
        ))}
      </ol>
      {status.attempts && (
        <section aria-label="Лимиты попыток AI">
          <h3>Резерв попыток AI</h3>
          <p>
            За {status.attempts.day} (UTC) зарезервировано:{" "}
            {status.attempts.reservedToday} из{" "}
            {status.attempts.globalDailyLimit}. На пользователя:{" "}
            {status.attempts.userDailyLimit} в сутки. На одно сообщение: не
            более {status.attempts.maxPerRequest} попыток.
          </p>
          {!status.attempts.configurationMatches && (
            <p role="alert">
              Лимиты сервера отличаются от зафиксированных на сегодня. Новые
              попытки заблокированы до согласования настроек.
            </p>
          )}
          {status.attempts.pinnedLimits && (
            <p>
              Зафиксировано на сегодня:{" "}
              {status.attempts.pinnedLimits.userDailyLimit} на пользователя,{" "}
              {status.attempts.pinnedLimits.globalDailyLimit} на сервис.
            </p>
          )}
          <p>
            Это резерв до вызова модели, а не счёт провайдера. Сбои, отмены и
            повторы расходуют резерв; ошибка авторизации может остановить вызов
            ещё до отправки сообщения. Денежный бюджет пока не настроен. Лимиты
            не меняются через этот интерфейс.
          </p>
          <p>
            Первый резерв фиксирует лимиты на текущий день UTC для всех
            серверов. Ноль в серверной настройке немедленно запрещает новые
            попытки. Суточные ограничения принятых сообщений действуют отдельно.
          </p>
          <h4>Последние резервы</h4>
          <ol>
            {status.attempts.recent.map((entry) => (
              <li
                key={`${entry.threadId}/${entry.requestId}/${entry.attemptNumber}`}
              >
                {names[entry.provider]} · {entry.model} · попытка{" "}
                {entry.attemptNumber} · версия {entry.routingRevision}
                {" · пользователь #"}
                {entry.userId}
                {" · "}
                {new Date(entry.reservedAt).toLocaleString("ru-RU")}
                {" · состояние сообщения: "}
                {
                  {
                    running: "в обработке",
                    complete: "завершено",
                    interrupted: "прервано",
                  }[entry.requestStatus]
                }
              </li>
            ))}
          </ol>
        </section>
      )}
    </Card>
  );
}

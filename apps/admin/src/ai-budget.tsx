"use client";
import { useState } from "react";
import { Button, Card } from "@citygo/ui-web";
import {
  aiBudgetInputSchema,
  formatMoneyMicros,
  parseMoneyMicros,
  type AiBudgetInput,
  type AiBudgetStatus,
} from "@citygo/contracts";

export function AiBudgetControls({
  status,
  busy,
  onSave,
}: {
  status: AiBudgetStatus;
  busy: boolean;
  onSave: (input: AiBudgetInput) => void;
}) {
  const { settings } = status;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [currency, setCurrency] = useState(settings.currency ?? "");
  const [daily, setDaily] = useState(
    formatMoneyMicros(settings.dailyLimitMicros),
  );
  const [total, setTotal] = useState(
    formatMoneyMicros(settings.totalLimitMicros),
  );
  const [userDaily, setUserDaily] = useState(
    settings.userDailyLimitMicros == null
      ? ""
      : formatMoneyMicros(settings.userDailyLimitMicros),
  );
  const [ceilings, setCeilings] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      status.availableExecutions.map((execution) => {
        const rule = settings.rules.find((item) => item.key === execution.key);
        return [
          execution.key,
          rule ? formatMoneyMicros(rule.attemptCeilingMicros) : "",
        ];
      }),
    ),
  );
  const [confirmed, setConfirmed] = useState(false);
  // Only a genuinely blank field clears the cap. Invalid nonblank text must
  // fail validation, not be mistaken for an explicit null/clear operation.
  const userDailyMicros = userDaily.trim()
    ? (parseMoneyMicros(userDaily) ?? NaN)
    : null;
  const parsed = aiBudgetInputSchema.safeParse({
    expectedRevision: settings.revision,
    enabled,
    currency,
    dailyLimitMicros: parseMoneyMicros(daily),
    totalLimitMicros: parseMoneyMicros(total),
    userDailyLimitMicros: userDailyMicros,
    rules: status.availableExecutions
      .filter((item) => ceilings[item.key]?.trim())
      .map((item) => ({
        key: item.key,
        attemptCeilingMicros: parseMoneyMicros(ceilings[item.key]!),
      })),
  });
  const ceilingsAboveUserCap =
    userDailyMicros !== null && Number.isSafeInteger(userDailyMicros)
      ? status.availableExecutions.filter((execution) => {
          const ceiling = parseMoneyMicros(ceilings[execution.key] ?? "");
          return ceiling !== null && ceiling > userDailyMicros;
        })
      : [];
  const lostRules = settings.rules.filter(
    (rule) => !status.availableExecutions.some((item) => item.key === rule.key),
  );
  const money = (amount: number) =>
    `${formatMoneyMicros(amount)} ${settings.currency ?? "(валюта не выбрана)"}`;
  return (
    <Card style={{ marginTop: 20, overflowWrap: "anywhere" }}>
      <section aria-label="Денежный бюджет AI">
        <h2>Денежный резерв AI</h2>
        <p>
          Новые резервы:{" "}
          {settings.enabled
            ? "разрешены для подтверждённых моделей"
            : "запрещены"}
          . Версия бюджета: {settings.revision}.
        </p>
        <p>
          Всего зарезервировано: {money(status.totalReservedMicros)} из{" "}
          {money(settings.totalLimitMicros)}. За {status.day} (UTC):{" "}
          {money(status.reservedTodayMicros)} из{" "}
          {money(settings.dailyLimitMicros)}.
        </p>
        <p>
          Это лимит выделенного резерва, не фактический счёт провайдера. Перед
          каждой попыткой, включая повтор, резервируется весь заданный потолок.
          Автоматических возвратов нет. Исторические вызовы до включения учёта
          сюда не входят.
        </p>
        <p>
          Действующий лимит на аккаунт в сутки UTC:{" "}
          {settings.userDailyLimitMicros == null
            ? "без отдельного ограничения"
            : money(settings.userDailyLimitMicros)}
          . Общий и суточный бюджеты проекта продолжают действовать независимо.
        </p>
        <p>
          До включения проверьте тариф, налоги и достаточность потолка для
          указанной модели, входа, выхода и служебных расходов. Байты не равны
          токенам. Неверно заданный потолок не гарантирует ограничение счёта
          провайдера. Конвертации валют нет.
        </p>
        <fieldset
          disabled={busy}
          style={{ minWidth: 0, border: 0, padding: 0 }}
          onChange={() => setConfirmed(false)}
        >
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Разрешить новые денежные резервы</span>
          </label>
          <label className="cg-field">
            <span>Валюта бюджета</span>
            <select
              value={currency}
              disabled={status.totalReservedMicros > 0}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option value="">Выберите валюту</option>
              <option value="RUB">RUB</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <p>
            После первого резерва валюта фиксируется. Изменения бюджета не
            обнуляют накопленную сумму.
          </p>
          <label className="cg-field">
            <span>Общий бюджет</span>
            <input
              inputMode="decimal"
              value={total}
              onChange={(event) => setTotal(event.target.value)}
            />
          </label>
          <label className="cg-field">
            <span>Бюджет на сутки UTC</span>
            <input
              inputMode="decimal"
              value={daily}
              onChange={(event) => setDaily(event.target.value)}
            />
          </label>
          <label className="cg-field">
            <span>Лимит на аккаунт в сутки UTC</span>
            <input
              inputMode="decimal"
              value={userDaily}
              placeholder="500"
              onChange={(event) => setUserDaily(event.target.value)}
            />
          </label>
          <p>
            Лимит для каждого аккаунта в той же валюте бюджета:{" "}
            {currency || "не выбрана"}. Пустое поле — без отдельного лимита; 0
            запрещает новые резервы. Учитываются выделенные резервы, не
            фактические списания. Новый день начинается в 00:00 UTC (03:00 по
            Москве); накопленные резервы проекта не сбрасываются.
          </p>
          <p>
            Суммы в выбранной валюте, до 6 знаков после точки или запятой.
            Максимум 1 000 000. Пустой потолок оставляет модель без разрешения.
          </p>
          {status.availableExecutions.map((execution) => (
            <div key={execution.key}>
              <h3>
                {execution.policy.recipient} · {execution.policy.model}
              </h3>
              <p>{execution.policy.routing}</p>
              <p>
                Вход: не более {execution.maxInputBytes} байт JSON-контекста;
                выход: не более {execution.maxOutputTokens} токенов. При
                изменении модели, получателя или этих ограничений нужно новое
                подтверждение.
              </p>
              <label className="cg-field">
                <span>Потолок на попытку · {execution.policy.recipient}</span>
                <input
                  inputMode="decimal"
                  value={ceilings[execution.key] ?? ""}
                  onChange={(event) =>
                    setCeilings((current) => ({
                      ...current,
                      [execution.key]: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          ))}
        </fieldset>
        {ceilingsAboveUserCap.length > 0 && (
          <p role="alert">
            Потолок на попытку выше лимита на аккаунт в сутки для:{" "}
            {ceilingsAboveUserCap
              .map(
                (execution) =>
                  `${execution.policy.recipient} · ${execution.policy.model}`,
              )
              .join(", ")}
            . Такие попытки будут недоступны. Модель, качество ответа и потолок
            автоматически не снижаются — проверьте согласованные ограничения.
          </p>
        )}
        {lostRules.length > 0 && (
          <p role="alert">
            При сохранении будут сняты устаревшие разрешения:{" "}
            {lostRules
              .map((rule) => `${rule.policy.recipient} · ${rule.policy.model}`)
              .join(", ")}
            . Уже выделенные суммы сохранятся.
          </p>
        )}
        {!parsed.success && (
          <p>
            Укажите валюту и корректные суммы. Для включения нужны положительный
            суточный бюджет и хотя бы один потолок; суточный бюджет не больше
            общего.
          </p>
        )}
        <p>
          Отключение останавливает только новые резервы, в том числе повторы.
          Уже зарезервированный ответ может завершиться. Выбор провайдера и
          согласие пользователя действуют независимо.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || !parsed.success}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            Подтверждаю бюджет, валюту и проверенные потолки для выбранных
            моделей.
          </span>
        </label>
        <Button
          disabled={busy || !confirmed || !parsed.success}
          style={{ maxWidth: "100%", whiteSpace: "normal" }}
          onClick={() => {
            if (parsed.success) onSave(parsed.data);
          }}
        >
          Сохранить денежный бюджет
        </Button>
        <h3>Последние изменения бюджета</h3>
        <ol>
          {status.audit.map((item) => (
            <li key={item.id}>
              Версия {item.payload.to.revision} ·{" "}
              {item.payload.to.enabled ? "включён" : "отключён"} ·{" "}
              {formatMoneyMicros(item.payload.to.totalLimitMicros)}{" "}
              {item.payload.to.currency} общий /{" "}
              {formatMoneyMicros(item.payload.to.dailyLimitMicros)} суточный ·{" "}
              {item.payload.to.userDailyLimitMicros == null
                ? "без отдельного лимита на аккаунт"
                : `${formatMoneyMicros(item.payload.to.userDailyLimitMicros)} ${item.payload.to.currency ?? ""} на аккаунт в сутки UTC`}{" "}
              · администратор #{item.actorUserId} ·{" "}
              {new Date(item.createdAt).toLocaleString("ru-RU")}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}

import {
  aiBudgetInputSchema,
  type AiBudgetInput,
  type AiBudgetSettings,
  type AiBudgetStatus,
  type AiExecution,
  type AiMoneyReservation,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

async function readBudget(tx: Sql) {
  const row = (
    await tx.query<{
      revision: number;
      enabled: boolean;
      currency: AiBudgetSettings["currency"];
      daily_limit_micros: string;
      total_limit_micros: string;
      total_reserved_micros: string;
      rules: AiBudgetSettings["rules"];
      day: string;
      today: string;
      reserved_at: string;
    }>(`with moment as materialized (select clock_timestamp() as at)
    select b.*,(m.at at time zone 'UTC')::date::text as day,coalesce(a.reserved_micros,0)::text as today,
    to_char(m.at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as reserved_at
    from ai_budget b cross join moment m
    left join ai_budget_daily a on a.usage_day=(m.at at time zone 'UTC')::date where b.id=1`)
  ).rows[0];
  if (!row)
    throw new DomainError(
      503,
      "Денежный бюджет AI не готов. Примените миграции.",
    );
  return {
    settings: {
      revision: row.revision,
      enabled: row.enabled,
      currency: row.currency,
      dailyLimitMicros: Number(row.daily_limit_micros),
      totalLimitMicros: Number(row.total_limit_micros),
      rules: row.rules,
    },
    totalReservedMicros: Number(row.total_reserved_micros),
    day: row.day,
    reservedTodayMicros: Number(row.today),
    reservedAt: row.reserved_at,
  };
}
export async function aiBudget(
  db: Sql,
  availableExecutions: AiExecution[],
): Promise<AiBudgetStatus> {
  const current = await readBudget(db);
  const audit = (
    await db.query<
      AiBudgetStatus["audit"][number]
    >(`select id::text,actor_user_id::text as "actorUserId",
    to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",payload
    from audit_log where entity_type='ai-budget' and entity_id='1' order by id desc limit 20`)
  ).rows;
  return {
    settings: current.settings,
    totalReservedMicros: current.totalReservedMicros,
    day: current.day,
    reservedTodayMicros: current.reservedTodayMicros,
    availableExecutions,
    audit,
  };
}
export async function changeAiBudget(
  db: Database,
  userId: string,
  raw: AiBudgetInput,
  available: AiExecution[],
) {
  const input = aiBudgetInputSchema.parse(raw);
  const rules = input.rules.map((rule) => {
    const execution = available.find((item) => item.key === rule.key);
    if (!execution)
      throw new DomainError(
        409,
        "Модель или ограничения изменились. Обновите бюджет и подтвердите заново.",
      );
    return { ...execution, attemptCeilingMicros: rule.attemptCeilingMicros };
  });
  return db.transaction(async (tx) => {
    // Same user -> budget order as attempt reservation; audit's user FK must
    // not acquire an actor lock after the budget lock. Never hold over model I/O.
    const actor = await tx.query(
      "select id from users where id=$1 for update",
      [userId],
    );
    if (!actor.rows.length) throw new DomainError(401, "Войдите в аккаунт");
    await tx.query("select id from ai_budget where id=1 for update");
    const current = await readBudget(tx);
    if (input.expectedRevision !== current.settings.revision)
      throw new DomainError(
        409,
        "Бюджет AI уже изменён. Обновите его и подтвердите заново.",
      );
    if (
      current.totalReservedMicros > 0 &&
      input.currency !== current.settings.currency
    )
      throw new DomainError(
        409,
        "После первого резерва валюту менять нельзя. Автоматической конвертации нет.",
      );
    if (
      input.totalLimitMicros < current.totalReservedMicros ||
      input.dailyLimitMicros < current.reservedTodayMicros
    )
      throw new DomainError(
        409,
        "Бюджет не может быть меньше уже зарезервированного. Для остановки отключите новые резервы.",
      );
    const next: AiBudgetSettings = {
      revision: current.settings.revision + 1,
      enabled: input.enabled,
      currency: input.currency,
      dailyLimitMicros: input.dailyLimitMicros,
      totalLimitMicros: input.totalLimitMicros,
      rules,
    };
    await tx.query(
      `update ai_budget set revision=$1,enabled=$2,currency=$3,daily_limit_micros=$4,total_limit_micros=$5,rules=$6 where id=1`,
      [
        next.revision,
        next.enabled,
        next.currency,
        next.dailyLimitMicros,
        next.totalLimitMicros,
        JSON.stringify(rules),
      ],
    );
    await tx.query(
      "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'ai-budget-changed','ai-budget','1',$2)",
      [userId, JSON.stringify({ from: current.settings, to: next })],
    );
    return next;
  });
}

// Called ONLY inside the attempt transaction, after its user/thread/counter locks.
// A failed money reservation rolls back the attempt counters and ledger as well.
export async function reserveAiMoney(
  tx: Sql,
  execution: AiExecution,
): Promise<AiMoneyReservation & { reservedAt: string }> {
  await tx.query("select id from ai_budget where id=1 for update");
  const current = await readBudget(tx);
  const { settings } = current;
  if (!settings.enabled || !settings.currency)
    throw new DomainError(
      503,
      "Денежный бюджет AI не включён администратором.",
    );
  const rule = settings.rules.find((item) => item.key === execution.key);
  if (
    !rule ||
    rule.policy.id !== execution.policy.id ||
    rule.maxInputBytes !== execution.maxInputBytes ||
    rule.maxOutputTokens !== execution.maxOutputTokens
  )
    throw new DomainError(
      503,
      "Денежный резерв для этой модели и её ограничений не подтверждён администратором.",
    );
  const amount = rule.attemptCeilingMicros;
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > settings.totalLimitMicros - current.totalReservedMicros ||
    amount > settings.dailyLimitMicros - current.reservedTodayMicros
  )
    throw new DomainError(
      429,
      "Денежный резерв AI исчерпан. Обратитесь к администратору.",
    );
  await tx.query(
    "update ai_budget set total_reserved_micros=total_reserved_micros+$1 where id=1",
    [amount],
  );
  await tx.query(
    "insert into ai_budget_daily(usage_day,reserved_micros) values ($1,$2) on conflict(usage_day) do update set reserved_micros=ai_budget_daily.reserved_micros+$2",
    [current.day, amount],
  );
  return {
    currency: settings.currency,
    amountMicros: amount,
    revision: settings.revision,
    ruleKey: execution.key,
    reservedAt: current.reservedAt,
  };
}

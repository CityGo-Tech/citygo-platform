import {
  aiBudgetInputSchema,
  type AiBudgetInput,
  type AiBudgetSettings,
  type AiBudgetStatus,
  type AiExecution,
  type AiMoneyReservation,
  type AiUserBudgetStatus,
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
      user_daily_limit_micros: string | null;
      rules: AiBudgetSettings["rules"];
      day: string;
      today: string;
      reserved_at: string;
      reset_at: string;
    }>(`with moment as materialized (select clock_timestamp() as at)
    select b.*,(m.at at time zone 'UTC')::date::text as day,coalesce(a.reserved_micros,0)::text as today,
    to_char(m.at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as reserved_at,
    to_char(((m.at at time zone 'UTC')::date+1)::timestamp,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as reset_at
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
      userDailyLimitMicros:
        row.user_daily_limit_micros == null
          ? null
          : Number(row.user_daily_limit_micros),
      rules: row.rules,
    },
    totalReservedMicros: Number(row.total_reserved_micros),
    day: row.day,
    reservedTodayMicros: Number(row.today),
    reservedAt: row.reserved_at,
    resetAt: row.reset_at,
  };
}

async function userReservedToday(
  tx: Sql,
  userId: string,
  currency: AiBudgetSettings["currency"],
  day: string,
) {
  const row = (
    await tx.query<{ reserved: string }>(
      `select coalesce(sum(money_reserved_micros),0)::text as reserved
       from ai_model_attempts
       where user_id=$1 and money_currency=$2 and money_reserved_micros is not null
       and reserved_at >= ($3::date::timestamp at time zone 'UTC')
       and reserved_at < (($3::date+1)::timestamp at time zone 'UTC')`,
      [userId, currency, day],
    )
  ).rows[0]!;
  return Number(row.reserved);
}

// Informational snapshot for the authenticated account only. Admission rechecks
// the same ledger under the existing user/budget locks; this is not provider billing.
export async function aiUserBudget(
  db: Sql,
  userId: string,
): Promise<AiUserBudgetStatus> {
  const current = await readBudget(db);
  const reservedTodayMicros = await userReservedToday(
    db,
    userId,
    current.settings.currency,
    current.day,
  );
  const limitMicros = current.settings.userDailyLimitMicros;
  return {
    currency: current.settings.currency,
    day: current.day,
    resetAt: current.resetAt,
    limitMicros,
    reservedTodayMicros,
    remainingMicros:
      limitMicros === null
        ? null
        : Math.max(0, limitMicros - reservedTodayMicros),
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
        "REVISION_CONFLICT",
        current.settings.revision,
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
      // Older clients omit this field: omission must never remove a newer cap.
      // An administrator can explicitly lower it below already reserved amounts;
      // that stops future reservations without rewriting history or refunding any.
      userDailyLimitMicros:
        input.userDailyLimitMicros === undefined
          ? current.settings.userDailyLimitMicros
          : input.userDailyLimitMicros,
      rules,
    };
    await tx.query(
      `update ai_budget set revision=$1,enabled=$2,currency=$3,daily_limit_micros=$4,total_limit_micros=$5,rules=$6,user_daily_limit_micros=$7 where id=1`,
      [
        next.revision,
        next.enabled,
        next.currency,
        next.dailyLimitMicros,
        next.totalLimitMicros,
        JSON.stringify(rules),
        next.userDailyLimitMicros,
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
  userId: string,
): Promise<AiMoneyReservation & { reservedAt: string }> {
  await tx.query("select id from ai_budget where id=1 for update");
  const current = await readBudget(tx);
  const { settings } = current;
  if (!settings.enabled || !settings.currency)
    throw new DomainError(
      503,
      "Денежный бюджет AI не включён администратором.",
      "AI_BUDGET_UNAVAILABLE",
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
      "AI_BUDGET_UNAVAILABLE",
    );
  const amount = rule.attemptCeilingMicros;
  if (settings.userDailyLimitMicros !== null) {
    const reserved = await userReservedToday(
      tx,
      userId,
      settings.currency,
      current.day,
    );
    if (
      !Number.isSafeInteger(reserved) ||
      reserved < 0 ||
      amount > settings.userDailyLimitMicros - reserved
    )
      throw new DomainError(
        429,
        "Суточный денежный резерв вашего аккаунта исчерпан. Следующие сутки начинаются в 00:00 UTC (03:00 по Москве).",
        "AI_BUDGET_EXHAUSTED",
      );
  }
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > settings.totalLimitMicros - current.totalReservedMicros ||
    amount > settings.dailyLimitMicros - current.reservedTodayMicros
  )
    throw new DomainError(
      429,
      "Денежный резерв AI исчерпан. Обратитесь к администратору.",
      "AI_BUDGET_EXHAUSTED",
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

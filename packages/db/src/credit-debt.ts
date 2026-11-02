import type { Sql } from "./index.js";
import type { AiRequestCostLimitMode } from "./request-cost-limit.js";
import { DomainError } from "./errors.js";
import { CITYGO_MAX_AMOUNT_MICROS } from "@citygo/contracts";

export type AiCreditReservationMode = "full" | "fixed5_overdraft";
export const FIXED_CITYGO_HOLD_MICROS = 5_000_000;
export const MAX_OVERDRAFT_MICROS = 55_000_000;
export const MAX_OVERDRAFT_REAL_CEILING_MICROS = 6_000_000;

export async function outstandingCreditDebt(sql: Sql, userId: string) {
  const row = (
    await sql.query<{ debt: string }>(
      `select coalesce(sum(d.principal_micros-coalesce(r.paid,0)),0)::text as debt
       from credit_charge_debts d left join
         (select debt_hold_id,sum(amount_micros) as paid from credit_debt_repayments where user_id=$1 group by debt_hold_id) r
         on r.debt_hold_id=d.hold_id where d.user_id=$1`,
      [userId],
    )
  ).rows[0]!;
  // Historical upgrade fixtures legitimately run before schema46 exists.
  // Real schema46 admissions include both durable debt families.
  const present =
    (
      await sql.query<{ present: boolean }>(
        "select to_regclass('public.credit_postpay_liabilities') is not null as present",
      )
    ).rows[0]?.present === true;
  const postpay = present
    ? (
        await sql.query<{ debt: string }>(
          `select coalesce(sum(d.principal_micros-coalesce(r.paid,0)),0)::text as debt from credit_postpay_liabilities d left join
    (select charge_id,sum(amount_micros) as paid from credit_postpay_repayments where user_id=$1 group by charge_id)r on r.charge_id=d.charge_id where d.user_id=$1`,
          [userId],
        )
      ).rows[0]!.debt
    : "0";
  const debt = Number(row.debt) + Number(postpay);
  if (
    !Number.isSafeInteger(debt) ||
    debt < 0 ||
    debt > CITYGO_MAX_AMOUNT_MICROS
  )
    throw new DomainError(503, "Долг баланса требует сверки");
  return debt;
}

// User/account locks are held by the caller. Repayments only allocate already
// verified free sources; they do not post another charge or alter paid amounts.
export async function repayCreditDebt(tx: Sql, userId: string) {
  await tx.query("select citygo_apply_credit_debt_repayments($1)", [userId]);
}

export async function assertCreditDebtPaid(tx: Sql, userId: string) {
  await repayCreditDebt(tx, userId);
  if ((await outstandingCreditDebt(tx, userId)) > 0)
    throw new DomainError(
      409,
      "Баланс CityGo отрицательный. Пополните его, чтобы погасить долг.",
      "AI_CREDIT_EXHAUSTED",
    );
}

export async function assertFixed5Admission(
  tx: Sql,
  userId: string,
  costLimitMode: AiRequestCostLimitMode = "operator_ceiling",
) {
  await assertCreditDebtPaid(tx, userId);
  const account = (
    await tx.query<{ spent: string }>(
      "select spent_micros::text as spent from ai_credit_accounts where user_id=$1",
      [userId],
    )
  ).rows[0];
  if (
    !account ||
    !Number.isSafeInteger(Number(account.spent)) ||
    Number(account.spent) >
      CITYGO_MAX_AMOUNT_MICROS -
        (costLimitMode === "user_balance"
          ? FIXED_CITYGO_HOLD_MICROS
          : MAX_OVERDRAFT_REAL_CEILING_MICROS * 10)
  )
    throw new DomainError(409, "Достигнут технический предел журнала AI");
  const pending = await tx.query(
    `select e.id from ai_credit_entries e where e.user_id=$1 and e.kind='hold'
      and not exists(select 1 from ai_credit_entries r where r.hold_id=e.operation_id) limit 1`,
    [userId],
  );
  if (pending.rows.length)
    throw new DomainError(
      409,
      "Предыдущий денежный резерв AI ещё не сверен. Дождитесь подтверждения стоимости.",
      "AI_CREDIT_UNAVAILABLE",
    );
}

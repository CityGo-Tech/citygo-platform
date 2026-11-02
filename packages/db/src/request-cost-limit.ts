import { CITYGO_MAX_AMOUNT_MICROS, MAX_MONEY_MICROS } from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";
import {
  assertFixed5Admission,
  FIXED_CITYGO_HOLD_MICROS,
} from "./credit-debt.js";

export type AiRequestCostLimitMode = "operator_ceiling" | "user_balance";
export type BalanceCostLimitSnapshot = {
  balanceBeforeHoldMicros: number;
  realCeilingMicros: number;
};

/** Called inside admission's security -> user -> account transaction, before
 * the fixed 5 CityGo hold. A concurrent spend/refund cannot change this snapshot.
 * This is an accounting/admission limit, not a provider's hard billing promise. */
export async function captureBalanceCostLimit(
  tx: Sql,
  userId: string,
): Promise<BalanceCostLimitSnapshot> {
  await assertFixed5Admission(tx, userId, "user_balance");
  const row = (
    await tx.query<{ available: string }>(
      "select (granted_micros-held_micros-spent_micros)::text as available from ai_credit_accounts where user_id=$1 for update",
      [userId],
    )
  ).rows[0];
  const available = row ? Number(row.available) : NaN;
  if (
    !Number.isSafeInteger(available) ||
    available < FIXED_CITYGO_HOLD_MICROS ||
    available > CITYGO_MAX_AMOUNT_MICROS
  )
    throw new DomainError(
      409,
      "Недостаточно доступного баланса CityGo для резерва этого ответа.",
      "AI_CREDIT_EXHAUSTED",
    );
  // Never multiply/divide a floating point currency. Sub-microrouble fractions
  // cannot enlarge the provider-cost limit; final debit still uses exact ×10.
  const realCeilingMicros = Number(BigInt(available) / 10n);
  if (realCeilingMicros < 500_000 || realCeilingMicros > MAX_MONEY_MICROS)
    throw new DomainError(
      409,
      "Достигнут технический предел денежного журнала AI",
      "AI_CREDIT_UNAVAILABLE",
    );
  return { balanceBeforeHoldMicros: available, realCeilingMicros };
}

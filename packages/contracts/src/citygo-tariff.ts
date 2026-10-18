import { z } from "zod";

// This is a pure tariff foundation, not an activated wallet or payment flow.
// Provider receipts remain real RUB; CityGo balance units are accounted separately.
export const REAL_RUB_MICROS_PER_RUBLE = 1_000_000;
export const CITYGO_RUB_MICROS_PER_RUBLE = 1_000_000;
export const REAL_MAX_COST_MICROS = 1_000_000_000_000;
export const CITYGO_MAX_AMOUNT_MICROS = 10_000_000_000_000;
export const CITYGO_WELCOME_CREDIT_MICROS = 500_000_000;

export const citygoTariffSnapshotSchema = z.discriminatedUnion("version", [
  z.strictObject({
    version: z.literal("legacy-at-cost-v1"),
    realCurrency: z.literal("RUB"),
    balanceUnit: z.literal("CITYGO_RUB"),
    numerator: z.literal(1),
    denominator: z.literal(1),
  }),
  z.strictObject({
    version: z.literal("citygo-10x-v1"),
    realCurrency: z.literal("RUB"),
    balanceUnit: z.literal("CITYGO_RUB"),
    numerator: z.literal(10),
    denominator: z.literal(1),
  }),
]);
export type CityGoTariffSnapshot = Readonly<
  z.infer<typeof citygoTariffSnapshotSchema>
>;

// Callers must persist and replay the chosen snapshot. There is no implicit
// "current tariff" default that could reprice previously recorded operations.
export const LEGACY_AT_COST_TARIFF: CityGoTariffSnapshot = Object.freeze({
  version: "legacy-at-cost-v1",
  realCurrency: "RUB",
  balanceUnit: "CITYGO_RUB",
  numerator: 1,
  denominator: 1,
});
export const CITYGO_10X_TARIFF: CityGoTariffSnapshot = Object.freeze({
  version: "citygo-10x-v1",
  realCurrency: "RUB",
  balanceUnit: "CITYGO_RUB",
  numerator: 10,
  denominator: 1,
});

function realCostFraction(costRub: string): {
  numerator: bigint;
  denominator: bigint;
} {
  if (typeof costRub !== "string" || costRub.length > 80)
    throw new Error("Invalid real RUB cost");
  // Match the bounded decimal/scientific receipt grammar without Number(value).
  const match = /^(\d{1,13})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(
    costRub,
  );
  if (!match) throw new Error("Invalid real RUB cost");
  const fraction = match[2] ?? "";
  const shift = Number(match[3] ?? 0) + 6 - fraction.length;
  if (Math.abs(shift) > 60) throw new Error("Invalid real RUB cost");
  const digits = BigInt(match[1]! + fraction);
  const numerator = shift >= 0 ? digits * 10n ** BigInt(shift) : digits;
  const denominator = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  // Bound the exact value, including fractions above the maximum, before floor.
  if (numerator > BigInt(REAL_MAX_COST_MICROS) * denominator)
    throw new Error("Real RUB cost exceeds maximum");
  return { numerator, denominator };
}

export function citygoDebitFromRealCostRub(
  costRub: string,
  snapshot: CityGoTariffSnapshot,
): { realCostMicros: number; citygoDebitMicros: number } {
  const tariff = citygoTariffSnapshotSchema.parse(snapshot);
  const real = realCostFraction(costRub);
  // Floor only after applying the tariff. Rounding the real receipt first would
  // lose chargeable CityGo microunits at sub-microrouble provider prices.
  // This customer-favouring rounding is not enforcement of an exact real-cost
  // gift cap; reservations and the real-cost ledger need their own controls.
  const debit =
    (real.numerator * BigInt(tariff.numerator)) /
    (real.denominator * BigInt(tariff.denominator));
  if (debit > BigInt(CITYGO_MAX_AMOUNT_MICROS))
    throw new Error("CityGo debit exceeds maximum");
  return {
    realCostMicros: Number(real.numerator / real.denominator),
    citygoDebitMicros: Number(debit),
  };
}

export function reserveCitygoMicros(
  realMicros: number,
  snapshot: CityGoTariffSnapshot,
): number {
  const tariff = citygoTariffSnapshotSchema.parse(snapshot);
  if (
    !Number.isSafeInteger(realMicros) ||
    realMicros < 0 ||
    realMicros > REAL_MAX_COST_MICROS
  )
    throw new Error("Invalid real RUB reservation");
  const scaled = BigInt(realMicros) * BigInt(tariff.numerator);
  const divisor = BigInt(tariff.denominator);
  // A reservation must cover the ceiling, even if a future approved ratio has
  // a denominator. The strict snapshots currently only permit exact 1x/10x.
  const reserved = (scaled + divisor - 1n) / divisor;
  if (reserved > BigInt(CITYGO_MAX_AMOUNT_MICROS))
    throw new Error("CityGo reservation exceeds maximum");
  return Number(reserved);
}

export function citygoTopUpMicrosFromPaidKopeks(paidKopeks: number): number {
  if (!Number.isSafeInteger(paidKopeks) || paidKopeks <= 0)
    throw new Error("Invalid paid RUB kopeks");
  // A paid rouble credits one CityGo rouble. The 10x AI spending tariff never
  // multiplies a payment or the one-time welcome grant.
  const credited = BigInt(paidKopeks) * 10_000n;
  if (credited > BigInt(CITYGO_MAX_AMOUNT_MICROS))
    throw new Error("CityGo top-up exceeds maximum");
  return Number(credited);
}

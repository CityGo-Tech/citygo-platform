import type { AdminPaymentRefund, AdminPaymentSource } from "@citygo/contracts";

// No Number(decimal)*100 rounding and no fractional-kopeck refund requests.
export function refundKopeks(value: string): number | null {
  const match = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount =
    BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return amount >= 100n && amount <= 1_000_000_000n ? Number(amount) : null;
}
export function sourceRefundable(
  source: Pick<AdminPaymentSource, "test" | "availableMicros">,
  amountKopeks: number | null,
) {
  return (
    source.test &&
    amountKopeks !== null &&
    Number.isSafeInteger(amountKopeks) &&
    amountKopeks >= 100 &&
    Number.isSafeInteger(source.availableMicros) &&
    source.availableMicros >= 0 &&
    BigInt(amountKopeks) * 10_000n <= BigInt(source.availableMicros)
  );
}
export function refundCanSubmit(
  refund: Pick<AdminPaymentRefund, "test" | "status">,
) {
  return refund.test && refund.status === "reserved";
}
export function refundCanReconcile(
  refund: Pick<AdminPaymentRefund, "test" | "status" | "attemptCount">,
) {
  return (
    refund.test &&
    refund.attemptCount > 0 &&
    ["unknown", "pending", "review_required"].includes(refund.status)
  );
}
export function refundMicros(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  return `${Math.floor(value / 1_000_000).toLocaleString("ru-RU")},${String(value % 1_000_000).padStart(6, "0")} ₽`;
}

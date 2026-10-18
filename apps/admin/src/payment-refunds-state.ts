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
    typeof source.test === "boolean" &&
    amountKopeks !== null &&
    Number.isSafeInteger(amountKopeks) &&
    amountKopeks >= 100 &&
    amountKopeks <= 1_000_000_000 &&
    Number.isSafeInteger(source.availableMicros) &&
    source.availableMicros >= 0 &&
    BigInt(amountKopeks) * 10_000n <= BigInt(source.availableMicros)
  );
}
export function refundCanSubmit(
  refund: Pick<AdminPaymentRefund, "test" | "status">,
) {
  return typeof refund.test === "boolean" && refund.status === "reserved";
}
export function refundCanReconcile(
  refund: Pick<AdminPaymentRefund, "test" | "status" | "attemptCount">,
) {
  return (
    typeof refund.test === "boolean" &&
    Number.isSafeInteger(refund.attemptCount) &&
    refund.attemptCount > 0 &&
    ["unknown", "pending", "review_required"].includes(refund.status)
  );
}
// Independent acknowledgements: reserving local funds does not authorize the
// external POST, and a successful POST is not the separate GET settlement.
export function refundConfirmationText(
  test: boolean,
  step: "reserve" | "submit",
) {
  if (step === "reserve")
    return test
      ? "Подтверждаю резервирование выбранной суммы из этого sandbox-платежа, без отправки провайдеру."
      : "Подтверждаю резервирование выбранной суммы из этого боевого платежа. Запрос ЮKassa не отправляется; это ещё не возврат настоящих денег.";
  return test
    ? "Подтверждаю отдельную отправку этого тестового возврата."
    : "Отдельно подтверждаю отправку этого боевого возврата в ЮKassa: будут возвращаться настоящие деньги покупателю. Резервирование само по себе этого не разрешало.";
}
export function refundMicros(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) return "—";
  return `${Math.floor(value / 1_000_000).toLocaleString("ru-RU")},${String(value % 1_000_000).padStart(6, "0")} ₽`;
}

import type { AiAccess, Message } from "@citygo/contracts";

export function messageInterruptionLabel(message: Message) {
  if (message.status !== "interrupted") return null;
  return message.role === "assistant" &&
    message.failureCode === "AI_CREDIT_EXHAUSTED"
    ? "Запрос не отправлен ИИ"
    : "Ответ прерван";
}

// This is explanatory UI only, never a replacement for the server's reservation.
export function hasEmptyChargeBalance(access?: AiAccess) {
  const credit = access?.credit;
  const minimum =
    credit?.minimumRequestBalanceMicros ??
    (credit?.reservationMode === "fixed5_overdraft" ? 5_000_000 : null);
  return (
    !!credit &&
    ["routerai_at_cost", "routerai_citygo_10x"].includes(
      credit.chargingStatus,
    ) &&
    ((credit.outstandingDebtMicros ?? 0) > 0 ||
      (minimum === null
        ? credit.availableMicros <= 0
        : credit.availableMicros < minimum))
  );
}

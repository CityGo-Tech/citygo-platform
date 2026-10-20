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
  return (
    !!credit &&
    ["routerai_at_cost", "routerai_citygo_10x"].includes(
      credit.chargingStatus,
    ) &&
    credit.availableMicros === 0
  );
}

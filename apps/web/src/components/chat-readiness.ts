import { createElement, type MouseEvent } from "react";
import type { AiAccess, Message } from "@citygo/contracts";

export const chatBalanceTarget = "citygo-balance";

export function messageInterruptionLabel(
  message: Message,
  legacyLabel: string,
) {
  if (message.status !== "interrupted") return null;
  return message.role === "assistant" &&
    message.failureCode === "AI_CREDIT_EXHAUSTED"
    ? "Запрос не отправлен ИИ"
    : legacyLabel;
}

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

/** Guidance only: human handoff and authoritative server admission remain usable. */
export function EmptyAiCreditHint({
  access,
  onBalance,
}: {
  access?: AiAccess;
  onBalance?: () => void;
}) {
  if (!hasEmptyChargeBalance(access)) return null;
  return createElement(
    "p",
    { role: "note", className: "chat-credit-hint" },
    access?.credit?.reservationMode === "fixed5_overdraft"
      ? "Для нового платного ответа ИИ нужно не менее 5 ₽ CityGo доступного баланса. Пополнение сначала погашает задолженность. Проверку резерва выполняет сервер. "
      : "На балансе недостаточно доступных средств для платного ответа ИИ. Необходимый резерв проверяется сервером. ",
    createElement(
      "a",
      {
        href: "#" + chatBalanceTarget,
        onClick(event: MouseEvent<HTMLAnchorElement>) {
          // The legacy Journey uses hashes as routes. Focus the existing balance
          // section without replacing #chat, creating a payment or opening a tab.
          event.preventDefault();
          if (onBalance) {
            onBalance();
            return;
          }
          const target = document.getElementById(chatBalanceTarget);
          target?.scrollIntoView({ block: "start" });
          target?.focus({ preventScroll: true });
        },
      },
      "Баланс и пополнение",
    ),
  );
}

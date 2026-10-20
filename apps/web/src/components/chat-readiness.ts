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
  return (
    !!credit &&
    ["routerai_at_cost", "routerai_citygo_10x"].includes(
      credit.chargingStatus,
    ) &&
    credit.availableMicros === 0
  );
}

/** Guidance only: human handoff and authoritative server admission remain usable. */
export function EmptyAiCreditHint({ access }: { access?: AiAccess }) {
  if (!hasEmptyChargeBalance(access)) return null;
  return createElement(
    "p",
    { role: "note", className: "chat-credit-hint" },
    "На балансе нет доступных средств для платного ответа ИИ. Необходимый резерв проверяется сервером. ",
    createElement(
      "a",
      {
        href: "#" + chatBalanceTarget,
        onClick(event: MouseEvent<HTMLAnchorElement>) {
          // The legacy Journey uses hashes as routes. Focus the existing balance
          // section without replacing #chat, creating a payment or opening a tab.
          event.preventDefault();
          const target = document.getElementById(chatBalanceTarget);
          target?.scrollIntoView({ block: "start" });
          target?.focus({ preventScroll: true });
        },
      },
      "Баланс и пополнение",
    ),
  );
}

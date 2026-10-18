import { createSessionGuard, StaleSessionError } from "@citygo/api-client";

// Selection lifetime is narrower than the authenticated session: a late detail
// response for A must not replace B, even if the network ignores cancellation.
export function createReceiptPanelGuard() {
  const session = createSessionGuard();
  let selection = 0;
  return {
    capture: session.capture,
    reset() {
      selection++;
      session.reset();
    },
    select() {
      const current = ++selection;
      const ticket = session.capture();
      return {
        signal: ticket.signal,
        active: () => ticket.active() && current === selection,
        check() {
          ticket.check();
          if (current !== selection) throw new StaleSessionError();
        },
      };
    },
  };
}

export function receiptMoney(amountKopeks: number) {
  if (!Number.isSafeInteger(amountKopeks) || amountKopeks < 0) return "—";
  const whole = Math.floor(amountKopeks / 100).toLocaleString("ru-RU");
  return `${whole},${String(amountKopeks % 100).padStart(2, "0")} ₽`;
}

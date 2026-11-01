import type { SessionTicket } from "@citygo/api-client";
export type LogoutConfirmationIntent = {
  owner: string;
  ticket: SessionTicket;
  trigger?: HTMLButtonElement;
};
export function currentLogoutConfirmation(
  intent: LogoutConfirmationIntent,
  owner: string | null,
  signal: AbortSignal,
) {
  return (
    intent.owner === owner &&
    intent.ticket.signal === signal &&
    intent.ticket.active() &&
    !signal.aborted
  );
}
/** One deliberate UI decision, independent from the unchanged revocation flow. */
export function createLogoutDecision(options: {
  current: () => boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  let decided = false;
  return {
    confirm() {
      if (decided || !options.current()) return false;
      decided = true;
      options.onClose();
      options.onConfirm();
      return true;
    },
    cancel() {
      if (decided || !options.current()) return false;
      decided = true;
      options.onClose();
      return true;
    },
    dispose() {
      decided = true;
    },
  };
}

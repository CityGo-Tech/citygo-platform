import {
  createAiModeConsentResource,
  createClient,
  isAiModeAvailable,
  type AiModeConsentView,
  type SessionTicket,
} from "@citygo/api-client";
import type { AiModeId, Dashboard } from "@citygo/contracts";

/** A native selection pins the credential and owner until it is cancelled. */
export function createMobileAiModeConsent(options: {
  base: string;
  token: string;
  userId: string;
  ticket: SessionTicket;
  fetch: typeof globalThis.fetch;
  refresh: (ticket: SessionTicket) => Promise<Dashboard | undefined>;
  select: (mode: AiModeId) => void;
  publish: (view: AiModeConsentView) => void;
  onAccessDenied: () => void;
}) {
  const { ticket, userId, token } = options;
  const client = (signal: AbortSignal) =>
    createClient(options.base, {
      native: true,
      fetch: options.fetch,
      token: () => token,
      signal: () => signal,
      // Only the active selection may handle a 401. A late old response must
      // never log out the next account via a global transport callback.
    });
  return createAiModeConsentResource({
    userId,
    sessionSignal: ticket.signal,
    load: (signal) => client(signal).accountConsents(),
    save: (choice, signal) => client(signal).confirmAiModesConsent(choice),
    verifyOwner: async (signal) => {
      ticket.check();
      const current = await client(signal).dashboard();
      ticket.check();
      return (
        current.user.id === userId &&
        !current.user.mustChangePassword &&
        !current.user.serviceConsentRequired
      );
    },
    onConfirmed: async (mode, signal) => {
      ticket.check();
      if (signal.aborted) return;
      const current = await options.refresh(ticket);
      ticket.check();
      if (signal.aborted) return;
      if (
        !current ||
        current.user.id !== userId ||
        current.user.mustChangePassword ||
        current.user.serviceConsentRequired ||
        !current.aiAccess.modes ||
        !isAiModeAvailable(current.aiAccess.modes, mode, false)
      )
        throw new Error("Mode unavailable after confirmation");
      options.select(mode);
    },
    onBaseConsentRequired: async () => {
      ticket.check();
      await options.refresh(ticket);
      ticket.check();
    },
    onAccessDenied: () => {
      if (ticket.active()) options.onAccessDenied();
    },
    publish: options.publish,
  });
}

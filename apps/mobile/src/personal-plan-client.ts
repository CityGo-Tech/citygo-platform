import {
  createClient,
  createPersonalPlanResource,
  type PersonalPlanState,
  type SessionTicket,
} from "@citygo/api-client";

/** A private plan pins the credential and owner for this screen's lifetime. */
export function createMobilePersonalPlan(options: {
  base: string;
  token: string;
  userId: string;
  sessionTicket: SessionTicket;
  fetch: typeof globalThis.fetch;
  publish: (state: PersonalPlanState) => void;
  onAccessDenied: () => void;
}) {
  const { token, userId, sessionTicket } = options;
  const client = (signal: AbortSignal) =>
    createClient(options.base, {
      native: true,
      fetch: options.fetch,
      token: () => token,
      signal: () => signal,
      // The resource handles an active denial. A late 401 from an old screen
      // must never terminate a subsequent account's session.
    });
  return createPersonalPlanResource({
    userId,
    sessionSignal: sessionTicket.signal,
    client: {
      page: (before, status, signal) =>
        client(signal).personalPlan(before, status),
      summary: (signal) => client(signal).personalPlanSummary(),
      update: (item, value, signal) =>
        client(signal).updatePersonalPlanItem(item.id, value),
      remove: (item, signal) =>
        client(signal).removePersonalPlanItem(item.id, item.revision),
    },
    publish: options.publish,
    onAccessDenied: () => {
      if (sessionTicket.active()) options.onAccessDenied();
    },
  });
}

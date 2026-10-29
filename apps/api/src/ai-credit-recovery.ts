import { DomainError } from "@citygo/db";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Observe a disconnect before SSE takes over, without treating the normal
 * completion of the incoming request body as a cancelled response. */
export function observeChatClientDisconnect(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const abort = new AbortController();
  const onAborted = () => abort.abort();
  const onClose = () => {
    if (!response.writableEnded) abort.abort();
  };
  request.once("aborted", onAborted);
  response.once("close", onClose);
  if (request.aborted || response.destroyed) abort.abort();
  return {
    abort,
    dispose() {
      request.off("aborted", onAborted);
      response.off("close", onClose);
    },
  };
}

export type PendingChatCharge = {
  holdId: string;
  responseComplete: boolean | null;
  generationPresent: boolean;
};

const pending = () =>
  new DomainError(
    409,
    "Стоимость предыдущего запроса ещё проверяется. Попробуйте позже.",
    "AI_CREDIT_UNAVAILABLE",
  );

/** One owned, completed generation GET per explicit new message request.
 * No daemon, delay, model retry, release or request/history write participates.
 * The caller's normal admission transaction remains authoritative afterwards.
 */
export async function recoverCompletedChatCharge(input: {
  charges: readonly PendingChatCharge[];
  signal: AbortSignal;
  reconcile: (holdId: string, signal: AbortSignal) => Promise<unknown>;
  reportPending: () => void;
}): Promise<void> {
  if (!input.charges.length) return;
  // An ambiguous legacy collection, interrupted response or non-Router hold is
  // not proof of a final charge. Never dispatch a model or guess a free result.
  const charge = input.charges[0]!;
  if (
    input.charges.length !== 1 ||
    !charge.responseComplete ||
    !charge.generationPresent
  )
    throw pending();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5000)]);
  try {
    signal.throwIfAborted();
    await input.reconcile(charge.holdId, signal);
    signal.throwIfAborted();
  } catch {
    // Do not log errors, IDs, credentials, provider bodies or message content.
    input.reportPending();
    throw pending();
  }
}

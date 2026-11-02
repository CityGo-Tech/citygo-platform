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

export type CompletedLegacyCharge = { holdId: string; userId: string };
/** One GET-only legacy slot per existing postpay batch. Backoff/cursor are
 * process-local rate controls; the legacy ledger is the durable once-only gate.
 * A restart can repeat a cost GET, never a model POST or a posted debit. */
export class LegacyCompletedChargeRecovery {
  private cursor?: string;
  private readonly pending = new Map<
    string,
    { failures: number; next: number }
  >();
  constructor(
    private readonly options: {
      list(
        after: string | undefined,
        limit: number,
      ): Promise<CompletedLegacyCharge[]>;
      reconcile(
        charge: CompletedLegacyCharge,
        signal: AbortSignal,
      ): Promise<boolean>;
      now?: () => number;
    },
  ) {}
  async run(
    signal: AbortSignal,
  ): Promise<{ processed: number; retained: number }> {
    signal.throwIfAborted();
    const rows = await this.options.list(this.cursor, 20);
    signal.throwIfAborted();
    if (!rows.length) {
      this.cursor = undefined;
      return { processed: 0, retained: 0 };
    }
    for (const charge of rows) {
      this.cursor = charge.holdId;
      const now = (this.options.now ?? Date.now)();
      const prior = this.pending.get(charge.holdId);
      if (prior && prior.next > now) continue;
      let settled = false;
      try {
        settled = await this.options.reconcile(
          charge,
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        );
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      if (settled) {
        this.pending.delete(charge.holdId);
        return { processed: 1, retained: 0 };
      }
      const failures = Math.min((prior?.failures ?? 0) + 1, 16);
      if (!this.pending.has(charge.holdId) && this.pending.size >= 256)
        this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(charge.holdId, {
        failures,
        next: now + Math.min(21600000, 30000 * 2 ** failures),
      });
      return { processed: 0, retained: 1 };
    }
    return { processed: 0, retained: 0 };
  }
}

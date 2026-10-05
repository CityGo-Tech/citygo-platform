import { z } from "zod";
import {
  r1PermissionCommandSchema,
  r1SyntheticOwnerSchema,
  r1SyntheticPermissionSnapshotSchema,
  r1SyntheticPermissionWriteResponseSchema,
  r1SyntheticPermissionRejectionHttpStatus,
  r1SyntheticPermissionLookupResponseSchema,
  r1NoticeReferenceSchema,
  r1AiRouteReferenceSchema,
  type R1PermissionCommand,
  type R1PermissionScope,
  type R1SyntheticPermissionSnapshot,
} from "@citygo/contracts";

// Offline protocol/controller for future clients. No fetch, key, storage,
// token, provider, automatic retry, or Web/Expo activation. Each instance is
// bound to the identity established by the surrounding authenticated client.
const checkpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal("synthetic_only"),
  ownerId: r1SyntheticOwnerSchema,
  command: r1PermissionCommandSchema,
});
function freeze<T>(input: T): T {
  if (input !== null && typeof input === "object") {
    for (const item of Object.values(input)) freeze(item);
    Object.freeze(input);
  }
  return input;
}
function canonicalCommand(input: unknown): R1PermissionCommand | null {
  const parsed = r1PermissionCommandSchema.safeParse(input);
  if (!parsed.success) return null;
  parsed.data.requestId = parsed.data.requestId.toLowerCase();
  return freeze(parsed.data);
}
function commandIdentity(command: R1PermissionCommand) {
  return JSON.stringify({
    schemaVersion: command.schemaVersion,
    requestId: command.requestId,
    scope: command.scope,
    action: command.action,
    expectedRevision: command.expectedRevision,
    notice:
      command.action === "grant"
        ? { id: command.notice.id, version: command.notice.version }
        : null,
    route:
      command.action === "grant" && command.scope === "ai_transfer"
        ? {
            revision: command.route.revision,
            disclosureId: command.route.disclosureId,
          }
        : null,
  });
}
type RecoveryStatus =
  | "empty"
  | "loading"
  | "ready"
  | "sending"
  | "uncertain"
  | "recorded_need_refresh"
  | "rejected_need_refresh"
  | "unavailable"
  | "closed";
const ticketBrand: unique symbol = Symbol("synthetic-recovery-ticket");
export type R1SyntheticRecoveryTicket = Readonly<{ [ticketBrand]: true }>;
const restoredGrantConfirmationSchema = z.strictObject({
  requestId: z.uuid(),
  notice: r1NoticeReferenceSchema,
  route: r1AiRouteReferenceSchema.optional(),
});

export class R1SyntheticPermissionRecovery {
  readonly ownerId: string;
  readonly scope: R1PermissionScope;
  #readTicket: R1SyntheticRecoveryTicket | null = null;
  #lookupTicket: R1SyntheticRecoveryTicket | null = null;
  #snapshot: R1SyntheticPermissionSnapshot | null = null;
  #status: RecoveryStatus = "empty";
  #pending: {
    command: R1PermissionCommand;
    uncertain: boolean;
    ticket: R1SyntheticRecoveryTicket | null;
    restored: boolean;
  } | null = null;
  constructor(authenticatedOwnerId: string, scope: R1PermissionScope) {
    this.ownerId = r1SyntheticOwnerSchema.parse(authenticatedOwnerId);
    this.scope = z.enum(["citygo_context", "ai_transfer"]).parse(scope);
    Object.freeze(this); // Bind public identity/scope at runtime as well as TS.
  }
  private nextTicket() {
    // Identity, not a counter/serialized value. Tickets from any other
    // instance (including the same owner after login) cannot match.
    return Object.freeze({ [ticketBrand]: true as const });
  }
  private invalidateRead() {
    this.#readTicket = null;
    this.#snapshot = null;
  }
  state() {
    return freeze({
      status: this.#status,
      snapshot: this.#snapshot,
      pendingCommand: this.#pending?.command ?? null,
      canStartCommand: this.#snapshot !== null && this.#pending === null,
    });
  }
  // Terminal LOCAL invalidation for logout/session replacement. This neither
  // aborts transport nor revokes/erases a possibly committed server command.
  // A caller must not reuse this instance or reroute its callbacks to a new one.
  close() {
    this.invalidateRead();
    this.#pending = null;
    this.#lookupTicket = null;
    this.#status = "closed";
  }
  beginRead() {
    if (this.#status === "closed")
      throw new Error("Synthetic recovery session closed");
    this.#snapshot = null;
    this.#readTicket = this.nextTicket();
    if (!this.#pending) this.#status = "loading";
    return this.#readTicket;
  }
  acceptRead(
    ticket: R1SyntheticRecoveryTicket,
    httpStatus: number,
    body: unknown,
  ) {
    if (this.#status === "closed") return false;
    if (ticket !== this.#readTicket) return false;
    this.#readTicket = null;
    const parsed = r1SyntheticPermissionSnapshotSchema.safeParse(body);
    if (
      httpStatus !== 200 ||
      !parsed.success ||
      parsed.data.ownerId !== this.ownerId
    ) {
      this.#snapshot = null;
      if (!this.#pending) this.#status = "unavailable";
      return false;
    }
    this.#snapshot = freeze(parsed.data);
    if (!this.#pending) this.#status = "ready";
    // A GET is not proof that an uncertain older command did/didn't commit.
    // Never clear a pending command just because current state differs.
    return true;
  }
  beginCommand(input: unknown): {
    ticket: R1SyntheticRecoveryTicket;
    command: R1PermissionCommand;
  } | null {
    if (this.#status === "closed") return null;
    if (this.#pending || !this.#snapshot) return null;
    const command = canonicalCommand(input);
    const selected = this.#snapshot.scopes[this.scope];
    if (
      !command ||
      command.scope !== this.scope ||
      command.expectedRevision !== selected.revision
    )
      return null;
    if (
      command.action === "grant" &&
      (selected.grantAvailability !== "available_fixture" ||
        command.notice.id !== selected.notice?.reference.id ||
        command.notice.version !== selected.notice.reference.version ||
        (command.scope === "ai_transfer" &&
          (command.route.revision !== selected.route?.revision ||
            command.route.disclosureId !== selected.route.disclosureId)))
    )
      return null;
    const ticket = this.nextTicket();
    this.#pending = { command, uncertain: false, ticket, restored: false };
    this.#lookupTicket = null;
    this.invalidateRead();
    this.#status = "sending";
    return freeze({ ticket, command });
  }
  retryCommand(confirmation?: unknown): {
    ticket: R1SyntheticRecoveryTicket;
    command: R1PermissionCommand;
  } | null {
    if (this.#status === "closed") return null;
    // Explicit user/caller retry only, after an uncertain response. Preserve
    // EXACT request ID, revision, notice/route and content; no automatic rebase.
    if (!this.#pending?.uncertain || this.#pending.ticket !== null) return null;
    if (this.#lookupTicket !== null) return null;
    const pending = this.#pending;
    if (pending.restored && pending.command.action === "grant") {
      // Persistence is untrusted, not evidence that this session saw a text.
      // A caller must display this fresh exact text/route, then pass an explicit
      // matching confirmation. Historical lookup below needs no new grant.
      const shown = restoredGrantConfirmationSchema.safeParse(confirmation);
      const selected = this.#snapshot?.scopes[this.scope];
      const command = pending.command;
      if (
        !shown.success ||
        !selected ||
        selected.grantAvailability !== "available_fixture" ||
        selected.revision !== command.expectedRevision ||
        shown.data.requestId.toLowerCase() !== command.requestId ||
        shown.data.notice.id !== command.notice.id ||
        shown.data.notice.version !== command.notice.version ||
        selected.notice?.reference.id !== command.notice.id ||
        selected.notice.reference.version !== command.notice.version ||
        (command.scope === "citygo_context"
          ? shown.data.route !== undefined
          : shown.data.route?.revision !== command.route.revision ||
            shown.data.route.disclosureId !== command.route.disclosureId ||
            selected.route?.revision !== command.route.revision ||
            selected.route.disclosureId !== command.route.disclosureId)
      )
        return null;
    }
    const ticket = this.nextTicket();
    this.#pending.ticket = ticket;
    this.invalidateRead();
    this.#status = "sending";
    return freeze({ ticket, command: this.#pending.command });
  }
  acceptWrite(
    ticket: R1SyntheticRecoveryTicket,
    httpStatus: number,
    body: unknown,
  ) {
    if (this.#status === "closed") return false;
    const pending = this.#pending;
    if (!pending || ticket !== pending.ticket) return false;
    pending.ticket = null;
    this.invalidateRead();
    const parsed = r1SyntheticPermissionWriteResponseSchema.safeParse(body);
    if (
      parsed.success &&
      parsed.data.status === "synthetic_recorded" &&
      httpStatus === 200
    ) {
      const saved = parsed.data.receipt;
      if (
        saved.ownerId === this.ownerId &&
        saved.scope === this.scope &&
        commandIdentity(saved.command) === commandIdentity(pending.command)
      ) {
        this.#pending = null;
        // Receipt is historical. A new GET is mandatory even for non-replay.
        this.#status = "recorded_need_refresh";
        return true;
      }
    }
    if (
      parsed.success &&
      parsed.data.status === "rejected" &&
      httpStatus ===
        r1SyntheticPermissionRejectionHttpStatus(parsed.data.code) &&
      !pending.uncertain
    ) {
      this.#pending = null;
      this.#status = "rejected_need_refresh";
      return true;
    }
    // Includes transport failure, invalid schema/status/binding, unconfirmed,
    // and a deterministic rejection AFTER an earlier uncertain attempt. That
    // rejection cannot prove the earlier attempt was never committed.
    pending.uncertain = true;
    this.#status = "uncertain";
    return false;
  }
  beginLookup() {
    if (
      this.#status === "closed" ||
      !this.#pending?.uncertain ||
      this.#pending.ticket !== null
    )
      return null;
    this.#lookupTicket = this.nextTicket();
    return freeze({
      ticket: this.#lookupTicket,
      scope: this.scope,
      requestId: this.#pending.command.requestId,
    });
  }
  acceptLookup(
    ticket: R1SyntheticRecoveryTicket,
    httpStatus: number,
    body: unknown,
  ) {
    if (
      this.#status === "closed" ||
      ticket !== this.#lookupTicket ||
      !this.#pending
    )
      return false;
    this.#lookupTicket = null;
    const parsed = r1SyntheticPermissionLookupResponseSchema.safeParse(body);
    if (
      httpStatus !== 200 ||
      !parsed.success ||
      parsed.data.status !== "synthetic_recorded"
    )
      return false; // Absence/refusal/time passing does NOT cancel an old attempt.
    const saved = parsed.data.receipt;
    if (
      saved.ownerId !== this.ownerId ||
      saved.scope !== this.scope ||
      commandIdentity(saved.command) !== commandIdentity(this.#pending.command)
    )
      return false;
    this.#pending = null;
    this.invalidateRead();
    this.#status = "recorded_need_refresh";
    return true;
  }
  checkpoint() {
    return this.#pending
      ? freeze({
          schemaVersion: 1 as const,
          mode: "synthetic_only" as const,
          ownerId: this.ownerId,
          command: this.#pending.command,
        })
      : null;
  }
  restorePending(input: unknown) {
    if (this.#status === "closed") return false;
    if (this.#pending) return false;
    const parsed = checkpointSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.ownerId !== this.ownerId ||
      parsed.data.command.scope !== this.scope
    )
      return false;
    const command = canonicalCommand(parsed.data.command)!;
    this.#pending = { command, uncertain: true, ticket: null, restored: true };
    this.#lookupTicket = null;
    this.invalidateRead();
    this.#status = "uncertain";
    return true;
  }
}

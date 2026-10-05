import { createHash } from "node:crypto";
import { z } from "zod";
import {
  entityIdSchema,
  r1AiRouteReferenceSchema,
  r1NoticeReferenceSchema,
  r1PermissionCommandSchema,
  r1PermissionScopeSchema,
  r1SyntheticNoticeDefinitionSchema,
  type R1AiRouteReference,
  type R1NoticeReference,
  type R1PermissionCommand,
  type R1PermissionScope,
} from "@citygo/contracts";

// Local synthetic preparation only: no HTTP registration, database, policy
// publication, permission grant or AI admission. Fixture status is NOT approval
// of a legal notice. A future handler must recheck fresh state under its lock.
const noticeDefinitionSchema = r1SyntheticNoticeDefinitionSchema;
const noticeRecordSchema = z.strictObject({
  reference: r1NoticeReferenceSchema,
  definition: noticeDefinitionSchema,
});
type NoticeDefinition = z.infer<typeof noticeDefinitionSchema>;
export type R1SyntheticNotice = Readonly<{
  reference: Readonly<R1NoticeReference>;
  definition: Readonly<NoticeDefinition>;
}>;

function noticeId(notice: NoticeDefinition): string {
  // Fixed field order and a synthetic namespace. Preserve the complete body,
  // including whitespace, instead of hashing only a URL or mutable version.
  // Administrative withdrawal does not rewrite a previously shown snapshot.
  return createHash("sha256")
    .update("citygo-r1-synthetic-notice-v1\0")
    .update(
      JSON.stringify({
        scope: notice.scope,
        version: notice.version,
        body: notice.body,
        routeDisclosureId: notice.routeDisclosureId,
      }),
    )
    .digest("hex");
}

export function prepareR1SyntheticNotice(input: unknown): R1SyntheticNotice {
  const parsed = noticeDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid synthetic notice definition");
  return Object.freeze({
    reference: Object.freeze({
      id: noticeId(parsed.data),
      version: parsed.data.version,
    }),
    definition: Object.freeze(parsed.data),
  });
}

const registrySchema = z.strictObject({
  notices: z.array(noticeRecordSchema).max(64),
  current: z.strictObject({
    citygo_context: r1NoticeReferenceSchema.nullable(),
    ai_transfer: r1NoticeReferenceSchema.nullable(),
  }),
});

export class R1SyntheticNoticeRegistry {
  #notices = new Map<string, R1SyntheticNotice>();
  #current: Readonly<
    Record<R1PermissionScope, Readonly<R1NoticeReference> | null>
  >;

  constructor(input: unknown) {
    const parsed = registrySchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid synthetic notice registry");
    const versions = new Set<string>();
    for (const record of parsed.data.notices) {
      const canonical = prepareR1SyntheticNotice(record.definition);
      const versionKey = `${record.definition.scope}:${record.definition.version}`;
      if (
        versions.has(versionKey) ||
        record.reference.id !== canonical.reference.id ||
        record.reference.version !== canonical.reference.version
      )
        throw new Error("Duplicate version or inconsistent synthetic notice");
      versions.add(versionKey);
      this.#notices.set(canonical.reference.id, canonical);
    }
    for (const scope of ["citygo_context", "ai_transfer"] as const) {
      const selected = parsed.data.current[scope];
      if (selected === null) continue;
      const record = this.#notices.get(selected.id);
      if (
        !record ||
        record.definition.scope !== scope ||
        record.reference.version !== selected.version
      ) {
        throw new Error("Invalid explicit synthetic notice selection");
      }
    }
    this.#current = Object.freeze({
      citygo_context:
        parsed.data.current.citygo_context === null
          ? null
          : Object.freeze(parsed.data.current.citygo_context),
      ai_transfer:
        parsed.data.current.ai_transfer === null
          ? null
          : Object.freeze(parsed.data.current.ai_transfer),
    });
  }

  current(scope: R1PermissionScope): R1SyntheticNotice | null {
    const selected = this.#current[scope];
    return selected === null ? null : (this.#notices.get(selected.id) ?? null);
  }
}

const ownerIdSchema = entityIdSchema.refine((value) => value === value.trim());
const decisionSchema = z.strictObject({
  ownerId: ownerIdSchema,
  scope: r1PermissionScopeSchema,
  revision: z.number().int().min(0).max(2147483647),
});
export type R1SyntheticPermissionContext = {
  mode: string;
  // Trusted caller inputs, NEVER fields read from an HTTP command body.
  authenticatedOwnerId: string | null;
  decision: z.infer<typeof decisionSchema> | null;
  registry: R1SyntheticNoticeRegistry | null;
  currentRoute: R1AiRouteReference | null;
};
export type R1SyntheticPermissionPreparation =
  | Readonly<{
      status: "rejected";
      code:
        | "SYNTHETIC_ONLY"
        | "UNAUTHENTICATED"
        | "INVALID_COMMAND"
        | "INVALID_DECISION"
        | "OWNER_OR_SCOPE_MISMATCH"
        | "REVISION_CONFLICT"
        | "REVISION_EXHAUSTED"
        | "POLICY_UNAVAILABLE"
        | "POLICY_NOT_APPROVED"
        | "NOTICE_CHANGED"
        | "ROUTE_UNAVAILABLE"
        | "ROUTE_CHANGED";
    }>
  | Readonly<{
      status: "prepared";
      ownerId: string;
      nextRevision: number;
      command: Readonly<R1PermissionCommand>;
      commandFingerprint: string;
    }>;

function commandFingerprint(command: R1PermissionCommand): string {
  // Payload identity only. A future journal MUST namespace replay by the
  // authenticated owner and scope; this hash is not a global request key.
  return createHash("sha256")
    .update("citygo-r1-synthetic-permission-command-v1\0")
    .update(
      JSON.stringify({
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
      }),
    )
    .digest("hex");
}

// Syntax and payload identity only, also used before looking up a saved replay.
// This does NOT evaluate current policy, revision, identity or permission.
export function parseR1SyntheticPermissionPayload(input: unknown): Readonly<{
  command: Readonly<R1PermissionCommand>;
  commandFingerprint: string;
}> | null {
  const parsed = r1PermissionCommandSchema.safeParse(input);
  if (!parsed.success) return null;
  const command = parsed.data;
  command.requestId = command.requestId.toLowerCase();
  if (command.action === "grant") {
    Object.freeze(command.notice);
    if (command.scope === "ai_transfer") Object.freeze(command.route);
  }
  return Object.freeze({
    command: Object.freeze(command),
    commandFingerprint: commandFingerprint(command),
  });
}

export function prepareR1SyntheticPermissionCommand(
  input: unknown,
  context: R1SyntheticPermissionContext,
): R1SyntheticPermissionPreparation {
  const reject = (
    code: Extract<
      R1SyntheticPermissionPreparation,
      { status: "rejected" }
    >["code"],
  ): R1SyntheticPermissionPreparation =>
    Object.freeze({ status: "rejected", code });
  if (context.mode !== "synthetic_only") return reject("SYNTHETIC_ONLY");
  const owner = ownerIdSchema.safeParse(context.authenticatedOwnerId);
  if (!owner.success) return reject("UNAUTHENTICATED");
  const payload = parseR1SyntheticPermissionPayload(input);
  if (!payload) return reject("INVALID_COMMAND");
  const command = payload.command;
  let revision = 0;
  if (context.decision !== null) {
    const decision = decisionSchema.safeParse(context.decision);
    if (!decision.success) return reject("INVALID_DECISION");
    if (
      decision.data.ownerId !== owner.data ||
      decision.data.scope !== command.scope
    ) {
      return reject("OWNER_OR_SCOPE_MISMATCH");
    }
    revision = decision.data.revision;
  }
  if (command.expectedRevision !== revision) return reject("REVISION_CONFLICT");
  if (revision === 2147483647) return reject("REVISION_EXHAUSTED");

  if (command.action === "grant") {
    const notice = context.registry?.current(command.scope);
    if (!notice) return reject("POLICY_UNAVAILABLE");
    if (notice.definition.status !== "approved_fixture")
      return reject("POLICY_NOT_APPROVED");
    if (
      command.notice.id !== notice.reference.id ||
      command.notice.version !== notice.reference.version
    ) {
      return reject("NOTICE_CHANGED");
    }
    if (command.scope === "ai_transfer") {
      const route = r1AiRouteReferenceSchema.safeParse(context.currentRoute);
      if (!route.success) return reject("ROUTE_UNAVAILABLE");
      if (
        command.route.revision !== route.data.revision ||
        command.route.disclosureId !== route.data.disclosureId ||
        notice.definition.routeDisclosureId !== route.data.disclosureId
      )
        return reject("ROUTE_CHANGED");
    }
  }
  return Object.freeze({
    status: "prepared",
    ownerId: owner.data,
    nextRevision: revision + 1,
    command,
    commandFingerprint: payload.commandFingerprint,
  });
}

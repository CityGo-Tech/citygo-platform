import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  entityIdSchema,
  r1AiRouteReferenceSchema,
  r1SyntheticPermissionSnapshotSchema,
  r1SyntheticPermissionLookupResponseSchema,
  projectR1SyntheticPermissionScope,
  type R1PermissionCommand,
  type R1PermissionScope,
  type R1SyntheticPermissionReadResponse,
  type R1SyntheticPermissionScopeState,
  type R1SyntheticPermissionLookupResponse,
} from "@citygo/contracts";
import type { Database, Sql } from "@citygo/db";
import {
  parseR1SyntheticPermissionPayload,
  prepareR1SyntheticPermissionCommand,
  R1SyntheticNoticeRegistry,
  type R1SyntheticPermissionPreparation,
} from "./r1-permission-planner.js";

// Explicit synthetic fixture only, no normal migrations or AI admission.
// The same database row serializes command writes AND configuration replacement.
// No network/AI work inside the transaction. Not a real permission/admission API.
const ownerSchema = entityIdSchema.refine((value) => value === value.trim());
const revisionSchema = z.number().int().min(1).max(2147483647);
const configurationSchema = z.strictObject({
  mode: z.literal("synthetic_only"),
  notices: z.array(z.unknown()).max(64),
  current: z.unknown(),
  route: r1AiRouteReferenceSchema.nullable(),
});
type Configuration = z.infer<typeof configurationSchema>;
type RejectionCode =
  | Extract<R1SyntheticPermissionPreparation, { status: "rejected" }>["code"]
  | "STORE_NOT_READY"
  | "STORED_DATA_INVALID"
  | "WRITE_NOT_COMMITTED"
  | "REQUEST_ID_REUSED"
  | "STORAGE_QUOTA_EXCEEDED";
export type R1SyntheticPermissionReceipt = Readonly<{
  eventId: string;
  ownerId: string;
  scope: R1PermissionScope;
  revision: number;
  configurationRevision: number;
  recordedAt: string;
  command: Readonly<R1PermissionCommand>;
}>;
export type R1SyntheticPermissionWriteResult =
  | Readonly<{ status: "rejected"; code: RejectionCode }>
  // Unknown commit outcome: retry the SAME request and payload, not a new ID.
  | Readonly<{ status: "unconfirmed"; code: "STORAGE_UNAVAILABLE" }>
  | Readonly<{
      status: "synthetic_recorded";
      replayed: boolean;
      receipt: R1SyntheticPermissionReceipt;
    }>;
type StoredCommand = {
  owner_id: string;
  scope: R1PermissionScope;
  request_id: string;
  fingerprint: string;
  command: unknown;
  event_id: string;
  result_revision: number;
  configuration_revision: number;
  recorded_at: Date | string;
};
const storedCommandSchema = z.strictObject({
  owner_id: ownerSchema,
  scope: z.enum(["citygo_context", "ai_transfer"]),
  request_id: z.uuid(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .length(64),
  command: z.unknown(),
  event_id: z.uuid(),
  result_revision: revisionSchema,
  configuration_revision: revisionSchema,
  recorded_at: z.union([z.date(), z.iso.datetime({ offset: true })]),
});
class InvalidStoredData extends Error {}
class WriteNotCommitted extends Error {}
// Local to this synthetic store. The Database contract runs work BEFORE
// COMMIT; a thrown callback cannot reach COMMIT, even if ROLLBACK also fails.
// Do not classify a COMMIT/ack error by SQLSTATE alone or change shared DB code.
async function writeTransaction<T>(
  db: Database,
  work: (tx: Sql) => Promise<T>,
) {
  let completed = false;
  let workError: unknown;
  try {
    return await db.transaction(async (tx) => {
      try {
        const result = await work(tx);
        completed = true;
        return result;
      } catch (error) {
        workError = error;
        throw error;
      }
    });
  } catch (error) {
    if (!completed) {
      const code =
        workError && typeof workError === "object" && "code" in workError
          ? workError.code
          : null;
      if (
        workError instanceof InvalidStoredData ||
        (typeof code === "string" && /^23[A-Z0-9]{3}$/.test(code))
      )
        throw new InvalidStoredData();
      throw new WriteNotCommitted();
    }
    throw error;
  }
}
function reject(code: RejectionCode): R1SyntheticPermissionWriteResult {
  return Object.freeze({ status: "rejected", code });
}
function readConfiguration(input: unknown) {
  const parsed = configurationSchema.safeParse(input);
  if (!parsed.success) throw new InvalidStoredData();
  try {
    return {
      snapshot: parsed.data,
      registry: new R1SyntheticNoticeRegistry({
        notices: parsed.data.notices,
        current: parsed.data.current,
      }),
    };
  } catch {
    throw new InvalidStoredData();
  }
}
async function lockRuntime(tx: Sql, lock: "update" | "share" = "update") {
  const row = (
    await tx.query<{
      mode: string;
      configuration_revision: number;
      max_route_revision: number;
    }>(`select mode,configuration_revision,max_route_revision
       from cg018_synthetic.runtime where id=1 for ${lock}`)
  ).rows[0];
  if (!row) return null;
  if (
    row.mode !== "synthetic_only" ||
    !revisionSchema.safeParse(row.configuration_revision).success ||
    !z.number().int().min(0).max(2147483647).safeParse(row.max_route_revision)
      .success
  )
    throw new InvalidStoredData();
  return row;
}
type Runtime = NonNullable<Awaited<ReturnType<typeof lockRuntime>>>;
const decisionSchema = z.strictObject({
  owner_id: ownerSchema,
  scope: z.enum(["citygo_context", "ai_transfer"]),
  revision: revisionSchema,
  event_id: z.uuid(),
});
// Same checks for readers/writers/control, always under the runtime lock.
// A revoke still checks pointers but need not parse any notice or route body.
async function verifyConfigurationHead(
  tx: Sql,
  runtime: Runtime,
  policyIndependent = false,
) {
  const head = (
    await tx.query<{
      revision: number;
      route_head: string;
      routes_readable: boolean;
    }>(
      `select max(revision)::int as revision,
       bool_and(coalesce(snapshot ? 'route' and (jsonb_typeof(snapshot->'route')='null'
       or (jsonb_typeof(snapshot->'route')='object' and jsonb_typeof(snapshot->'route'->'revision')='number')),false)) as routes_readable,
       coalesce(max(case when jsonb_typeof(snapshot->'route'->'revision')='number'
       then (snapshot->'route'->>'revision')::numeric else 0 end),0)::text as route_head
       from cg018_synthetic.configurations`,
    )
  ).rows[0];
  if (
    head?.revision !== runtime.configuration_revision ||
    (!head.routes_readable && !policyIndependent) ||
    (head.routes_readable &&
      (!z
        .number()
        .int()
        .min(0)
        .max(2147483647)
        .safeParse(Number(head.route_head)).success ||
        Number(head.route_head) !== runtime.max_route_revision))
  )
    throw new InvalidStoredData();
}
async function configurationHistory(tx: Sql, runtime: Runtime) {
  await verifyConfigurationHead(tx, runtime);
  const rows = (
    await tx.query<{ revision: number; snapshot: unknown }>(
      "select revision,snapshot from cg018_synthetic.configurations order by revision",
    )
  ).rows;
  if (
    rows.length !== runtime.configuration_revision ||
    rows.some((row, index) => row.revision !== index + 1)
  )
    throw new InvalidStoredData();
  const history = rows.map((row) => readConfiguration(row.snapshot));
  const routeHead = history.reduce(
    (max, entry) => Math.max(max, entry.snapshot.route?.revision ?? 0),
    0,
  );
  if (routeHead !== runtime.max_route_revision) throw new InvalidStoredData();
  for (const scope of ["citygo_context", "ai_transfer"] as const) {
    const selected = history.at(-1)!.registry.current(scope);
    if (
      selected?.definition.status === "approved_fixture" &&
      noticeRetired(history, scope, selected.reference.version)
    )
      throw new InvalidStoredData();
  }
  return history;
}
async function verifiedDecisions(tx: Sql, owner: string) {
  const decisions = (
    await tx.query<z.infer<typeof decisionSchema>>(
      "select owner_id,scope,revision,event_id::text from cg018_synthetic.decisions where owner_id=$1",
      [owner],
    )
  ).rows;
  const heads = (
    await tx.query<{ scope: R1PermissionScope; revision: number }>(
      `select scope,max(result_revision)::int as revision from cg018_synthetic.commands
       where owner_id=$1 group by scope`,
      [owner],
    )
  ).rows;
  if (
    !z.array(decisionSchema).max(2).safeParse(decisions).success ||
    decisions.some((entry) => entry.owner_id !== owner) ||
    new Set(decisions.map((entry) => entry.scope)).size !== decisions.length ||
    heads.length !== decisions.length ||
    heads.some(
      (head) =>
        !decisions.some(
          (entry) =>
            entry.scope === head.scope && entry.revision === head.revision,
        ),
    )
  )
    throw new InvalidStoredData();
  // Bind the pointer's event as well as its revision, for every owned scope.
  for (const decision of decisions) {
    const row = (
      await tx.query<StoredCommand>(
        `select ${commandColumns} from cg018_synthetic.commands
         where owner_id=$1 and scope=$2 and result_revision=$3 and event_id=$4`,
        [owner, decision.scope, decision.revision, decision.event_id],
      )
    ).rows[0];
    if (!row) throw new InvalidStoredData();
    receipt(row, owner, decision.scope, row.request_id);
  }
  return decisions;
}
function noticeRetired(
  history: Awaited<ReturnType<typeof configurationHistory>>,
  scope: R1PermissionScope,
  version: string,
) {
  let selected = false;
  let approved = false;
  for (const entry of history) {
    const notice = entry.registry.current(scope);
    if (notice?.reference.version !== version) {
      if (selected) return true; // Replaced/deselected versions are terminal.
      continue;
    }
    selected = true;
    if (notice.definition.status === "withdrawn_fixture") return true;
    if (approved && notice.definition.status !== "approved_fixture")
      return true;
    approved ||= notice.definition.status === "approved_fixture";
  }
  return false;
}
function receipt(
  row: StoredCommand,
  owner: string,
  scope: R1PermissionScope,
  requestId: string,
) {
  const stored = storedCommandSchema.safeParse(row);
  const payload = parseR1SyntheticPermissionPayload(row.command);
  if (
    !stored.success ||
    !payload ||
    row.owner_id !== owner ||
    row.scope !== scope ||
    row.request_id !== requestId ||
    payload.command.requestId !== requestId ||
    payload.command.scope !== scope ||
    payload.commandFingerprint !== row.fingerprint ||
    payload.command.expectedRevision + 1 !== row.result_revision
  )
    throw new InvalidStoredData();
  return Object.freeze({
    eventId: row.event_id,
    ownerId: owner,
    scope,
    revision: row.result_revision,
    configurationRevision: row.configuration_revision,
    recordedAt: new Date(row.recorded_at).toISOString(),
    command: payload.command,
  });
}
const commandColumns = `owner_id,scope,request_id::text,fingerprint,command,event_id::text,
  result_revision,configuration_revision,recorded_at`;

export class R1SyntheticPermissionStore {
  constructor(
    private readonly db: Database,
    private readonly mode: string,
    private readonly options: {
      verifyReadiness?: (tx: Sql) => Promise<boolean>;
      maxCommandsPerOwner?: number;
    } = {},
  ) {
    if (
      options.maxCommandsPerOwner !== undefined &&
      !z.number().int().min(1).max(1000).safeParse(options.maxCommandsPerOwner)
        .success
    )
      throw new Error("Invalid synthetic command quota");
  }

  private async ready(tx: Sql) {
    if (!this.options.verifyReadiness) return true;
    try {
      return await this.options.verifyReadiness(tx);
    } catch {
      return false;
    }
  }

  // Owner-scoped, point-in-time synthetic snapshot. SHARE serializes against
  // configuration/command UPDATE locks without serializing parallel readers.
  // No writes, pagination, inferred latest notice or real AI admission.
  async readCurrent(
    authenticatedOwnerId: string | null,
  ): Promise<R1SyntheticPermissionReadResponse> {
    if (this.mode !== "synthetic_only")
      return { status: "rejected", code: "SYNTHETIC_ONLY" };
    const owner = ownerSchema.safeParse(authenticatedOwnerId);
    if (!owner.success) return { status: "rejected", code: "UNAUTHENTICATED" };
    try {
      return await this.db.transaction(async (tx) => {
        if (!(await this.ready(tx)))
          return { status: "rejected", code: "STORE_NOT_READY" };
        const runtime = await lockRuntime(tx, "share");
        if (!runtime) return { status: "rejected", code: "STORE_NOT_READY" };
        // Detect a corrupted configuration pointer, never adopt the latest
        // configuration implicitly or return an obsolete selected notice.
        const history = await configurationHistory(tx, runtime);
        const selected = history.at(-1)!;
        // Detect a lost/rolled-back decision pointer, never reconstruct it by
        // silently picking "latest". A historical grant must not hide a later
        // revoke merely because an administrator corrupted the pointer.
        const decisions = await verifiedDecisions(tx, owner.data);
        const scopes = {} as Record<
          R1PermissionScope,
          R1SyntheticPermissionScopeState
        >;
        for (const scope of ["citygo_context", "ai_transfer"] as const) {
          const decision = decisions.find((entry) => entry.scope === scope);
          let lastDecision: R1SyntheticPermissionReceipt | null = null;
          if (decision) {
            const row = (
              await tx.query<StoredCommand>(
                `select ${commandColumns} from cg018_synthetic.commands
               where owner_id=$1 and scope=$2 and result_revision=$3 and event_id=$4`,
                [owner.data, scope, decision.revision, decision.event_id],
              )
            ).rows[0];
            if (!row) throw new InvalidStoredData();
            lastDecision = receipt(row, owner.data, scope, row.request_id);
          }
          const facts = {
            scope,
            lastDecision,
            notice: selected.registry.current(scope),
            route: scope === "ai_transfer" ? selected.snapshot.route : null,
          };
          scopes[scope] = {
            ...facts,
            revision: lastDecision?.revision ?? 0,
            ...projectR1SyntheticPermissionScope(facts),
          };
        }
        const snapshot = r1SyntheticPermissionSnapshotSchema.safeParse({
          schemaVersion: 1,
          mode: "synthetic_only",
          status: "synthetic_snapshot",
          ownerId: owner.data,
          configurationRevision: runtime.configuration_revision,
          scopes,
        });
        if (!snapshot.success) throw new InvalidStoredData();
        return snapshot.data;
      });
    } catch (error) {
      // A failed GET never claims no decision or a revoked state. Unlike a
      // write acknowledgement loss, there is no unconfirmed command here.
      return error instanceof InvalidStoredData
        ? { status: "rejected", code: "STORED_DATA_INVALID" }
        : { status: "unavailable", code: "STORAGE_UNAVAILABLE" };
    }
  }

  async execute(
    input: unknown,
    authenticatedOwnerId: string | null,
  ): Promise<R1SyntheticPermissionWriteResult> {
    if (this.mode !== "synthetic_only") return reject("SYNTHETIC_ONLY");
    const owner = ownerSchema.safeParse(authenticatedOwnerId);
    if (!owner.success) return reject("UNAUTHENTICATED");
    const payload = parseR1SyntheticPermissionPayload(input);
    if (!payload) return reject("INVALID_COMMAND");
    const { command } = payload;
    try {
      return await writeTransaction(this.db, async (tx) => {
        // A failed guard precedes ALL writes and is a definite rejection, not
        // an ambiguous commit. The guard uses this same transaction/role.
        if (!(await this.ready(tx))) return reject("STORE_NOT_READY");
        const runtime = await lockRuntime(tx);
        if (!runtime) return reject("STORE_NOT_READY");
        await verifyConfigurationHead(tx, runtime, command.action === "revoke");
        const decisions = await verifiedDecisions(tx, owner.data);
        // Saved successful replay FIRST: never reevaluate it against a new route,
        // withdrawn policy or later revision. A receipt is historical evidence.
        const previous = (
          await tx.query<StoredCommand>(
            `select ${commandColumns} from cg018_synthetic.commands
           where owner_id=$1 and scope=$2 and request_id=$3`,
            [owner.data, command.scope, command.requestId],
          )
        ).rows[0];
        if (previous) {
          const saved = receipt(
            previous,
            owner.data,
            command.scope,
            command.requestId,
          );
          if (previous.fingerprint !== payload.commandFingerprint)
            return reject("REQUEST_ID_REUSED");
          return Object.freeze({
            status: "synthetic_recorded",
            replayed: true,
            receipt: saved,
          });
        }
        const decision = decisions.find(
          (entry) => entry.scope === command.scope,
        );
        // Revocation needs no current notice or route (nor parsing their body).
        const selected =
          command.action === "grant"
            ? (await configurationHistory(tx, runtime)).at(-1)!
            : null;
        const prepared = prepareR1SyntheticPermissionCommand(command, {
          mode: this.mode,
          authenticatedOwnerId: owner.data,
          decision: decision
            ? {
                ownerId: decision.owner_id,
                scope: decision.scope,
                revision: decision.revision,
              }
            : null,
          registry: selected?.registry ?? null,
          currentRoute: selected?.snapshot.route ?? null,
        });
        if (prepared.status === "rejected") return prepared;
        if (this.options.maxCommandsPerOwner !== undefined) {
          const count = (
            await tx.query<{ n: number }>(
              "select count(*)::int as n from cg018_synthetic.commands where owner_id=$1",
              [owner.data],
            )
          ).rows[0]?.n;
          if (!z.number().int().min(0).safeParse(count).success)
            throw new InvalidStoredData();
          if (count! >= this.options.maxCommandsPerOwner) {
            // Two extra slots (one per scope) permit a real grant->revoke
            // transition at capacity. No further grants or no-op revokes:
            // total rows are bounded by max+2. Replay above costs no slot.
            if (command.action !== "revoke" || !decision)
              return reject("STORAGE_QUOTA_EXCEEDED");
            const current = (
              await tx.query<StoredCommand>(
                `select ${commandColumns} from cg018_synthetic.commands
                 where owner_id=$1 and scope=$2 and result_revision=$3`,
                [owner.data, command.scope, decision.revision],
              )
            ).rows[0];
            if (!current) throw new InvalidStoredData();
            const savedCurrent = receipt(
              current,
              owner.data,
              command.scope,
              current.request_id,
            );
            if (savedCurrent.command.action !== "grant")
              return reject("STORAGE_QUOTA_EXCEEDED");
          }
        }
        const row = (
          await tx.query<StoredCommand>(
            `insert into cg018_synthetic.commands
           (owner_id,scope,request_id,fingerprint,command,event_id,result_revision,configuration_revision)
           values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning ${commandColumns}`,
            [
              owner.data,
              command.scope,
              command.requestId,
              payload.commandFingerprint,
              JSON.stringify(command),
              randomUUID(),
              prepared.nextRevision,
              runtime.configuration_revision,
            ],
          )
        ).rows[0];
        if (!row) throw new InvalidStoredData();
        const saved = receipt(
          row,
          owner.data,
          command.scope,
          command.requestId,
        );
        await tx.query(
          `insert into cg018_synthetic.decisions (owner_id,scope,revision,event_id) values ($1,$2,$3,$4)
           on conflict (owner_id,scope) do update set revision=excluded.revision,event_id=excluded.event_id`,
          [owner.data, command.scope, prepared.nextRevision, saved.eventId],
        );
        return Object.freeze({
          status: "synthetic_recorded",
          replayed: false,
          receipt: saved,
        });
      });
    } catch (error) {
      // Never echo a SQL error, URL, owner, policy text or driver diagnostics.
      return error instanceof InvalidStoredData
        ? reject("STORED_DATA_INVALID")
        : error instanceof WriteNotCommitted
          ? reject("WRITE_NOT_COMMITTED")
          : Object.freeze({
              status: "unconfirmed",
              code: "STORAGE_UNAVAILABLE",
            });
    }
  }

  // Historical request lookup only. An absent row is a point-in-time fact,
  // NOT cancellation/fencing of an older in-flight attempt. No mutation.
  async readCommand(
    input: unknown,
    authenticatedOwnerId: string | null,
  ): Promise<R1SyntheticPermissionLookupResponse> {
    if (this.mode !== "synthetic_only")
      return { status: "rejected", code: "SYNTHETIC_ONLY" };
    const owner = ownerSchema.safeParse(authenticatedOwnerId);
    if (!owner.success) return { status: "rejected", code: "UNAUTHENTICATED" };
    const key = z
      .strictObject({
        scope: z.enum(["citygo_context", "ai_transfer"]),
        requestId: z.uuid(),
      })
      .safeParse(input);
    if (!key.success) return { status: "rejected", code: "INVALID_COMMAND" };
    const requestId = key.data.requestId.toLowerCase();
    try {
      return await this.db.transaction(async (tx) => {
        if (!(await this.ready(tx)))
          return { status: "rejected", code: "STORE_NOT_READY" };
        const runtime = await lockRuntime(tx, "share");
        if (!runtime) return { status: "rejected", code: "STORE_NOT_READY" };
        await verifyConfigurationHead(tx, runtime, true);
        await verifiedDecisions(tx, owner.data);
        const row = (
          await tx.query<StoredCommand>(
            `select ${commandColumns} from cg018_synthetic.commands where owner_id=$1 and scope=$2 and request_id=$3`,
            [owner.data, key.data.scope, requestId],
          )
        ).rows[0];
        const result = r1SyntheticPermissionLookupResponseSchema.safeParse(
          row
            ? {
                status: "synthetic_recorded",
                replayed: true,
                receipt: receipt(row, owner.data, key.data.scope, requestId),
              }
            : {
                status: "not_recorded_at_read",
                ownerId: owner.data,
                scope: key.data.scope,
                requestId,
              },
        );
        if (!result.success) throw new InvalidStoredData();
        return result.data;
      });
    } catch (error) {
      return error instanceof InvalidStoredData
        ? { status: "rejected", code: "STORED_DATA_INVALID" }
        : { status: "unavailable", code: "STORAGE_UNAVAILABLE" };
    }
  }

  // Trusted fixture-control operation only, NOT a client/API command. Its CAS
  // and route high-water mark prevent stale replacements and route ABA reuse.
  async replaceConfiguration(
    expectedRevision: number,
    registry: R1SyntheticNoticeRegistry,
    route: unknown,
  ) {
    const denied = (code: string) =>
      Object.freeze({ status: "rejected" as const, code });
    if (this.mode !== "synthetic_only") return denied("SYNTHETIC_ONLY");
    if (
      !revisionSchema.safeParse(expectedRevision).success ||
      !(registry instanceof R1SyntheticNoticeRegistry)
    )
      return denied("INVALID_CONFIGURATION");
    let next: Configuration;
    try {
      const context = registry.current("citygo_context");
      const ai = registry.current("ai_transfer");
      next = readConfiguration({
        mode: "synthetic_only",
        notices: [context, ai].filter((value) => value !== null),
        current: {
          citygo_context: context?.reference ?? null,
          ai_transfer: ai?.reference ?? null,
        },
        route,
      }).snapshot;
    } catch {
      return denied("INVALID_CONFIGURATION");
    }
    try {
      return await writeTransaction(this.db, async (tx) => {
        const runtime = await lockRuntime(tx);
        if (!runtime) return denied("STORE_NOT_READY");
        const history = await configurationHistory(tx, runtime);
        if (runtime.configuration_revision !== expectedRevision)
          return denied("CONFIGURATION_CONFLICT");
        if (expectedRevision === 2147483647)
          return denied("REVISION_EXHAUSTED");
        const previous = history.at(-1)!;
        const sameRoute =
          next.route !== null &&
          previous.snapshot.route !== null &&
          next.route.revision === previous.snapshot.route.revision &&
          next.route.disclosureId === previous.snapshot.route.disclosureId;
        if (
          next.route !== null &&
          !sameRoute &&
          next.route.revision <= runtime.max_route_revision
        )
          return denied("ROUTE_REVISION_REUSED");
        // Scope/version is immutable across ALL stored configurations, not just
        // within one supplied registry. Validate everything before any insert.
        const nextRegistry = readConfiguration(next).registry;
        const newNotices = [];
        for (const scope of ["citygo_context", "ai_transfer"] as const) {
          const record = nextRegistry.current(scope);
          if (!record) continue;
          if (
            record.definition.status === "approved_fixture" &&
            noticeRetired(history, scope, record.reference.version)
          )
            return denied("NOTICE_VERSION_RETIRED");
          const existing = (
            await tx.query<{ notice_id: string; record: unknown }>(
              "select notice_id,record from cg018_synthetic.notices where scope=$1 and version=$2",
              [scope, record.reference.version],
            )
          ).rows[0];
          if (existing) {
            try {
              // Also bind the dictionary's SQL scope/version/ID to its record.
              new R1SyntheticNoticeRegistry({
                notices: [existing.record],
                current: {
                  citygo_context:
                    scope === "citygo_context"
                      ? {
                          id: existing.notice_id,
                          version: record.reference.version,
                        }
                      : null,
                  ai_transfer:
                    scope === "ai_transfer"
                      ? {
                          id: existing.notice_id,
                          version: record.reference.version,
                        }
                      : null,
                },
              });
            } catch {
              throw new InvalidStoredData();
            }
            if (existing.notice_id !== record.reference.id)
              return denied("NOTICE_VERSION_REUSED");
          } else newNotices.push(record);
        }
        for (const record of newNotices) {
          await tx.query(
            "insert into cg018_synthetic.notices (scope,version,notice_id,record) values ($1,$2,$3,$4::jsonb)",
            [
              record.definition.scope,
              record.reference.version,
              record.reference.id,
              JSON.stringify(record),
            ],
          );
        }
        const revision = expectedRevision + 1;
        await tx.query(
          "insert into cg018_synthetic.configurations (revision,snapshot) values ($1,$2::jsonb)",
          [revision, JSON.stringify(next)],
        );
        await tx.query(
          `update cg018_synthetic.runtime set configuration_revision=$1,max_route_revision=$2 where id=1`,
          [
            revision,
            Math.max(runtime.max_route_revision, next.route?.revision ?? 0),
          ],
        );
        return Object.freeze({
          status: "configuration_updated" as const,
          revision,
        });
      });
    } catch (error) {
      return error instanceof InvalidStoredData
        ? denied("STORED_DATA_INVALID")
        : error instanceof WriteNotCommitted
          ? denied("WRITE_NOT_COMMITTED")
          : Object.freeze({
              status: "unconfirmed" as const,
              code: "STORAGE_UNAVAILABLE",
            });
    }
  }
}

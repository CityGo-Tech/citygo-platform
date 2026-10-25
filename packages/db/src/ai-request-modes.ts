import { z } from "zod";
import {
  serviceAiProcessingSchema,
  aiModeIdSchema,
  aiModeCatalogIdSchema,
  type AiModeId,
  type AiExecution,
} from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = serviceAiProcessingSchema.extend({
  model: z.string().min(1).max(200),
});
const executionSchema = z.strictObject({
  key: digest,
  policy: policySchema,
  maxInputBytes: z.number().int().min(1).max(1_000_000_000),
  maxOutputTokens: z.number().int().min(1).max(1_000_000_000),
});
const descriptorSchema = z.strictObject({
  id: aiModeIdSchema,
  catalogId: aiModeCatalogIdSchema,
});
const snapshotSchema = z.strictObject({
  mode: aiModeIdSchema,
  catalogId: aiModeCatalogIdSchema,
  policy: policySchema,
  execution: executionSchema,
  upstream: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
    .optional(),
});
export type AiRequestModeSnapshot = z.infer<typeof snapshotSchema>;
export type AiRequestModeDescriptor = { id: AiModeId; catalogId: string };
export const canonicalAiRequestMode = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
function invalid() {
  return new DomainError(400, "Некорректный профиль режима ИИ");
}
function conflict() {
  return new DomainError(409, "Режим ИИ не соответствует принятому запросу");
}
export function parseAiRequestModeSnapshot(
  raw: unknown,
): AiRequestModeSnapshot {
  const value = snapshotSchema.safeParse(raw);
  if (!value.success) throw invalid();
  const snapshot = value.data;
  if (
    canonicalAiRequestMode(snapshot.policy) !==
      canonicalAiRequestMode(snapshot.execution.policy) ||
    (snapshot.policy.provider === "routerai") !==
      (snapshot.upstream !== undefined) ||
    Buffer.byteLength(canonicalAiRequestMode(snapshot), "utf8") > 262144
  )
    throw invalid();
  return snapshot;
}
export async function recordAiRequestMode(
  tx: Sql,
  input: {
    userId: string;
    threadId: string;
    requestId: string;
    consentPolicyId: string;
    routingRevision: number;
    snapshot: AiRequestModeSnapshot;
  },
) {
  const snapshot = parseAiRequestModeSnapshot(input.snapshot);
  await tx.query(
    `insert into ai_request_modes(thread_id,request_id,user_id,consent_policy_id,routing_revision,
 mode,catalog_id,provider,model,policy_id,execution_key,upstream,snapshot)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [
      input.threadId,
      input.requestId,
      input.userId,
      input.consentPolicyId,
      input.routingRevision,
      snapshot.mode,
      snapshot.catalogId,
      snapshot.policy.provider,
      snapshot.policy.model,
      snapshot.policy.id,
      snapshot.execution.key,
      snapshot.upstream ?? null,
      JSON.stringify(snapshot),
    ],
  );
  return snapshot;
}
export async function assertAiRequestModeAttempt(
  tx: Sql,
  input: {
    userId: string;
    threadId: string;
    requestId: string;
    consentPolicyId: string;
    policyId: string;
    routingRevision: number;
    provider: string;
    model: string;
    execution: AiExecution;
    upstream?: string;
    mode?: AiRequestModeDescriptor;
  },
) {
  const rows = await tx.query<{
    user_id: string;
    consent_policy_id: string;
    routing_revision: number;
    snapshot: unknown;
  }>(
    "select user_id::text,consent_policy_id,routing_revision,snapshot from ai_request_modes where thread_id=$1 and request_id=$2",
    [input.threadId, input.requestId],
  );
  const stored = rows.rows[0];
  if (!stored) {
    if (input.mode !== undefined || input.consentPolicyId !== input.policyId)
      throw conflict();
    return undefined;
  }
  const descriptor = descriptorSchema.safeParse(input.mode);
  if (!descriptor.success) throw conflict();
  const snapshot = parseAiRequestModeSnapshot(stored.snapshot);
  if (
    stored.user_id !== input.userId ||
    stored.consent_policy_id !== input.consentPolicyId ||
    stored.routing_revision !== input.routingRevision ||
    descriptor.data.id !== snapshot.mode ||
    descriptor.data.catalogId !== snapshot.catalogId ||
    input.policyId !== snapshot.policy.id ||
    input.provider !== snapshot.policy.provider ||
    input.model !== snapshot.policy.model ||
    input.upstream !== snapshot.upstream ||
    canonicalAiRequestMode(input.execution) !==
      canonicalAiRequestMode(snapshot.execution)
  )
    throw conflict();
  return snapshot;
}

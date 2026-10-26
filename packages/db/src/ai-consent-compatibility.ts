import { createHash } from "node:crypto";
import type { AiExecution, AiPolicy } from "@citygo/contracts";
import { serviceAiProcessingSchema } from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";
import {
  buildServiceConsentPolicy,
  consentPolicyHash,
} from "./service-consent-policy.js";

export type LegacyBalancedConsentCompatibility = {
  routingPolicyId: string;
  policy: AiPolicy;
  execution: AiExecution;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const keys = (value: object, expected: string[]) =>
  Object.keys(value).sort().join(",") === expected.sort().join(",");
export function parseLegacyBalancedConsentCompatibility(
  input: LegacyBalancedConsentCompatibility | undefined,
) {
  if (!input) return undefined;
  const value = structuredClone(input),
    p = value.policy,
    e = value.execution;
  const { id, ...fields } = p;
  if (
    !keys(value, ["routingPolicyId", "policy", "execution"]) ||
    !keys(p, [
      "id",
      "version",
      "provider",
      "model",
      "recipient",
      "routing",
      "data",
    ]) ||
    !keys(e, ["key", "policy", "maxInputBytes", "maxOutputTokens"]) ||
    !/^[a-f0-9]{64}$/.test(value.routingPolicyId) ||
    value.routingPolicyId === id ||
    p.version !== "ai-recipient-v2" ||
    p.provider !== "routerai" ||
    p.model !== "deepseek/deepseek-v4-pro-0813" ||
    p.recipient !== "RouterAI" ||
    p.routing !==
      "Дополнительный получатель (upstream): deepseek. Фильтр страны: cn. Фильтр не гарантирует место хранения данных." ||
    hash({
      version: fields.version,
      provider: fields.provider,
      model: fields.model,
      recipient: fields.recipient,
      routing: fields.routing,
      data: fields.data,
    }) !== id ||
    JSON.stringify(canonical(e.policy)) !== JSON.stringify(canonical(p)) ||
    e.maxInputBytes !== 8192 ||
    e.maxOutputTokens !== 4096 ||
    e.key !==
      hash({
        version: "ai-reserve-v1",
        policyId: id,
        maxInputBytes: 8192,
        maxOutputTokens: 4096,
        creditReservationMode: "fixed5_overdraft",
      })
  )
    throw new DomainError(503, "Несовместимый прежний профиль ИИ");
  return value;
}

export type ConsentGrantEvidence = {
  policyId: string;
  serviceEventId: string;
  policyHash: string;
};
export async function consentGrantEvidence(
  tx: Sql,
  userId: string,
  policy: AiPolicy,
): Promise<ConsentGrantEvidence | undefined> {
  const snapshot = buildServiceConsentPolicy(policy),
    policyHash = consentPolicyHash(snapshot);
  // Observe the latest actual choices, never search behind a revocation or a
  // newer snapshot. This read only proves the SAME recipient/execution scope.
  const ai = (
    await tx.query<{
      action: string;
      policy_version: string;
      details: unknown;
    }>(
      "select action,policy_version,details from consent_events where user_id=$1 and consent_key='ai-recipient' order by id desc limit 1",
      [userId],
    )
  ).rows[0];
  if (
    !ai ||
    ai.action !== "granted" ||
    ai.policy_version !== policy.id ||
    JSON.stringify(canonical(ai.details)) !== JSON.stringify(canonical(policy))
  )
    return undefined;
  const row = (
    await tx.query<{
      id: string;
      policy_snapshot: unknown;
      policy_hash: string;
      policy_version: string;
      decision: string;
    }>(
      `select e.id::text,e.policy_snapshot,e.policy_hash,e.policy_version,e.decision from service_consent_events e
     join ai_consents a on a.user_id=e.user_id and a.policy_id=$2 and a.granted=true
     where e.user_id=$1 and e.purpose='personal-data' order by e.id desc limit 1`,
      [userId, policy.id],
    )
  ).rows[0];
  if (
    !row ||
    row.decision !== "granted" ||
    row.policy_version !== snapshot.version ||
    row.policy_hash !== policyHash ||
    consentPolicyHash(row.policy_snapshot as typeof snapshot) !== policyHash
  )
    return undefined;
  // Hash validation binds every field despite JSONB key ordering.
  return { policyId: policy.id, serviceEventId: row.id, policyHash };
}

export async function legacyBalancedGrant(
  tx: Sql,
  userId: string,
  compatibility: LegacyBalancedConsentCompatibility | undefined,
  routingPolicyId: string,
) {
  const value = parseLegacyBalancedConsentCompatibility(compatibility);
  if (!value || value.routingPolicyId !== routingPolicyId) return undefined;
  return consentGrantEvidence(tx, userId, value.policy);
}
export async function currentConsentGrant(
  tx: Sql,
  userId: string,
  policyId: string,
) {
  const row = (
    await tx.query<{ details: unknown }>(
      "select details from consent_events where user_id=$1 and consent_key='ai-recipient' order by id desc limit 1",
      [userId],
    )
  ).rows[0];
  const policy = serviceAiProcessingSchema.safeParse(row?.details);
  return policy.success && policy.data.id === policyId
    ? consentGrantEvidence(tx, userId, policy.data)
    : undefined;
}
export function unchangedLegacyBalancedSnapshot(
  compatibility: LegacyBalancedConsentCompatibility | undefined,
  routingPolicyId: string,
  snapshot:
    | {
        mode: string;
        policy: AiPolicy;
        execution: AiExecution;
        upstream?: string;
      }
    | undefined,
) {
  const value = parseLegacyBalancedConsentCompatibility(compatibility);
  return Boolean(
    value &&
    value.routingPolicyId === routingPolicyId &&
    snapshot?.mode === "balanced" &&
    snapshot.upstream === "deepseek" &&
    JSON.stringify(canonical(snapshot.policy)) ===
      JSON.stringify(canonical(value.policy)) &&
    JSON.stringify(canonical(snapshot.execution)) ===
      JSON.stringify(canonical(value.execution)),
  );
}

export async function recordAiConsentBasis(
  tx: Sql,
  input: {
    userId: string;
    threadId: string;
    requestId: string;
    routingPolicyId: string;
    grant: ConsentGrantEvidence;
    legacy: boolean;
  },
) {
  await tx.query(
    `insert into ai_request_consent_bases(thread_id,request_id,user_id,routing_policy_id,grant_policy_id,service_event_id,service_policy_hash,basis)
    values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.threadId,
      input.requestId,
      input.userId,
      input.routingPolicyId,
      input.grant.policyId,
      input.grant.serviceEventId,
      input.grant.policyHash,
      input.legacy ? "legacy-balanced" : "current",
    ],
  );
}

export async function assertAiConsentBasisAttempt(
  tx: Sql,
  input: {
    userId: string;
    threadId: string;
    requestId: string;
    routingPolicyId: string;
    snapshot: {
      mode: string;
      policy: AiPolicy;
      execution: AiExecution;
      upstream?: string;
    };
  },
  compatibility?: LegacyBalancedConsentCompatibility,
) {
  const row = (
    await tx.query<{
      user_id: string;
      routing_policy_id: string;
      grant_policy_id: string;
      service_policy_hash: string;
      basis: string;
      policy_snapshot: unknown;
      policy_hash: string;
    }>(
      `select b.user_id::text,b.routing_policy_id,b.grant_policy_id,b.service_policy_hash,b.basis,e.policy_snapshot,e.policy_hash
     from ai_request_consent_bases b join service_consent_events e on e.id=b.service_event_id
     where b.thread_id=$1 and b.request_id=$2`,
      [input.threadId, input.requestId],
    )
  ).rows[0];
  // An admitted request retains its real immutable receipt across later choices.
  // Do not consult the mutable ai_consents projection here.
  if (
    !row ||
    row.user_id !== input.userId ||
    row.routing_policy_id !== input.routingPolicyId ||
    row.service_policy_hash !== row.policy_hash ||
    consentPolicyHash(
      row.policy_snapshot as ReturnType<typeof buildServiceConsentPolicy>,
    ) !== row.service_policy_hash ||
    (row.basis === "current"
      ? row.grant_policy_id !== input.routingPolicyId
      : row.basis !== "legacy-balanced" ||
        !compatibility ||
        row.grant_policy_id !== compatibility.policy.id ||
        !unchangedLegacyBalancedSnapshot(
          compatibility,
          input.routingPolicyId,
          input.snapshot,
        ))
  )
    throw new DomainError(409, "Основание принятого запроса ИИ изменилось");
}

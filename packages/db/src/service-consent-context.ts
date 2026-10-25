import { createHash } from "node:crypto";
import {
  serviceAiProcessingSchema,
  serviceConsentPolicy,
  serviceConsentPolicySchema,
  type AiPolicy,
  type AiRouting,
  type ServiceConsentPolicy,
} from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";

export type ServiceAiPolicyResolver = (routing: AiRouting) => AiPolicy | null;
export type ServiceConsentContext = {
  policy: ServiceConsentPolicy;
  aiPolicy: AiPolicy | null;
  routing: AiRouting | null;
};

// JSONB reorders object keys. Evidence must have the same digest after storage.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const consentPolicyHash = (policy: ServiceConsentPolicy) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");

export function buildServiceConsentPolicy(
  aiPolicy: AiPolicy | null,
): ServiceConsentPolicy {
  if (!aiPolicy) return serviceConsentPolicy;
  const aiProcessing = serviceAiProcessingSchema.parse(aiPolicy);
  const snapshot: ServiceConsentPolicy = {
    ...serviceConsentPolicy,
    aiProcessing,
    personalData: {
      ...serviceConsentPolicy.personalData,
      text: [
        serviceConsentPolicy.personalData.text,
        "Обработку выполняет " + aiProcessing.recipient + ".",
        aiProcessing.routing,
        aiProcessing.data,
      ].join("\n\n"),
    },
  };
  // The existing submitted version binds the complete base text AND exact
  // runtime recipient/context. A fixed v2 cannot authorize a different policy.
  snapshot.version = "v2-ai-" + consentPolicyHash(snapshot);
  return serviceConsentPolicySchema.parse(snapshot);
}

/** Always acquire routing before account/security/user locks in the same tx. */
export async function readServiceConsentContext(
  tx: Sql,
  resolver?: ServiceAiPolicyResolver,
): Promise<ServiceConsentContext> {
  // Direct isolated DB fixtures have no provider registry and grant no AI.
  if (!resolver)
    return { policy: serviceConsentPolicy, aiPolicy: null, routing: null };
  const routing = (
    await tx.query<AiRouting>(
      'select provider,policy_id as "policyId",revision from ai_routing where id=1 for share',
    )
  ).rows[0];
  if (!routing)
    throw new DomainError(503, "Настройки обработки сообщений недоступны.");
  // The resolver describes a provider; it cannot rewrite the row against which
  // that description is checked, even accidentally mutating its argument.
  const resolved = resolver({ ...routing });
  const aiPolicy = resolved ? serviceAiProcessingSchema.parse(resolved) : null;
  if (
    aiPolicy &&
    (routing.provider === "disabled" ||
      routing.policyId !== aiPolicy.id ||
      routing.provider !== aiPolicy.provider)
  )
    throw new DomainError(
      409,
      "Условия обработки сообщений изменились. Подтвердите выбор заново.",
      "SERVICE_CONSENT_POLICY_CHANGED",
    );
  return {
    policy: buildServiceConsentPolicy(aiPolicy),
    aiPolicy,
    routing,
  };
}

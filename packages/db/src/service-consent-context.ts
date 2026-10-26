import {
  serviceAiProcessingSchema,
  serviceConsentPolicy,
  type AiPolicy,
  type AiRouting,
  type ServiceConsentPolicy,
} from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";
import { buildServiceConsentPolicy } from "./service-consent-policy.js";
export {
  buildServiceConsentPolicy,
  consentPolicyHash,
} from "./service-consent-policy.js";
import {
  parseLegacyBalancedConsentCompatibility,
  type LegacyBalancedConsentCompatibility,
} from "./ai-consent-compatibility.js";

export type ServiceAiPolicyResolver = (routing: AiRouting) => AiPolicy | null;
export type ServiceConsentContext = {
  policy: ServiceConsentPolicy;
  aiPolicy: AiPolicy | null;
  routing: AiRouting | null;
  legacyBalanced?: LegacyBalancedConsentCompatibility;
};

/** Always acquire routing before account/security/user locks in the same tx. */
export async function readServiceConsentContext(
  tx: Sql,
  resolver?: ServiceAiPolicyResolver,
  compatibility?: LegacyBalancedConsentCompatibility,
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
    // Human chose one explicit confirmation only on a NEW mode. This descriptor
    // describes the old unchanged DeepSeek route, never a grant to this bundle.
    ...(aiPolicy?.version === "ai-assistant-modes-v1" &&
    aiPolicy.model === "citygo/assistant-modes-v1" &&
    compatibility?.routingPolicyId === aiPolicy.id
      ? {
          legacyBalanced:
            parseLegacyBalancedConsentCompatibility(compatibility),
        }
      : {}),
  };
}

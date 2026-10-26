import { createHash } from "node:crypto";
import {
  serviceAiProcessingSchema,
  serviceConsentPolicy,
  serviceConsentPolicySchema,
  type AiPolicy,
  type ServiceConsentPolicy,
} from "@citygo/contracts";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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
  snapshot.version = "v2-ai-" + consentPolicyHash(snapshot);
  return serviceConsentPolicySchema.parse(snapshot);
}

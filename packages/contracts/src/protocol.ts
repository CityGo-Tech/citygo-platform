import { z } from "zod";

// HTTP/SSE wire version, independent of package releases and entity revisions.
export const CONTRACT_VERSION = "1" as const;
export const CONTRACT_VERSION_HEADER = "X-CityGo-Contract-Version";
export const REQUEST_ID_HEADER = "X-Request-Id";
export const contractVersionSchema = z.literal(CONTRACT_VERSION);
export const entityIdSchema = z.string().min(1).max(200).regex(/^\S+$/);
export const entityRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const entityRefSchema = z.object({
  id: entityIdSchema,
  revision: entityRevisionSchema,
});

// Headerless v1 clients/servers remain supported during rolling deployment.
// Do not accept lists, ranges or silently choose another major version.
export function supportsContractVersion(value: unknown): boolean {
  return value === undefined || value === null || value === CONTRACT_VERSION;
}

export const apiErrorCodes = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "CONTRACT_VERSION_UNSUPPORTED",
  "SERVICE_CONSENT_REQUIRED",
  "SERVICE_CONSENT_POLICY_CHANGED",
  "AI_UNAVAILABLE",
  "AI_POLICY_CHANGED",
  "AI_MODE_CHANGED",
  "AI_MODE_UNAVAILABLE",
  "AI_CONSENT_REQUIRED",
  "AI_QUOTA_EXHAUSTED",
  "AI_BUDGET_UNAVAILABLE",
  "AI_BUDGET_EXHAUSTED",
  "AI_CREDIT_EXHAUSTED",
  "AI_CREDIT_UNAVAILABLE",
  "REVISION_CONFLICT",
  "PLAN_STALE",
  "EVIDENCE_REQUIRED",
  "SOURCE_UNAVAILABLE",
  "HOUSING_STORAGE_LIMIT",
  "STREAM_INTERRUPTED",
] as const;
export const apiErrorCodeSchema = z.enum(apiErrorCodes);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
// Readers preserve bounded unknown codes from an additive v1 server release.
const wireErrorCode = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/);
export const errorMetadataSchema = z.object({
  contractVersion: contractVersionSchema.optional(),
  code: wireErrorCode.optional(),
  requestId: entityIdSchema.optional(),
  retryable: z.boolean().optional(),
  currentVersion: entityRevisionSchema.optional(),
});
export const apiErrorResponseSchema = errorMetadataSchema.extend({
  // Kept at the original location for already-released Web/native clients.
  error: z.string().min(1).max(2000),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export function errorCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 400 && status < 500
        ? "VALIDATION_ERROR"
        : "INTERNAL_ERROR";
  }
}
export function errorMetadata(
  code: ApiErrorCode,
  requestId: string,
  currentVersion?: number,
) {
  return {
    contractVersion: CONTRACT_VERSION,
    code,
    requestId,
    // Commands may already have committed. No automatic replay is authorized.
    retryable: false,
    ...(currentVersion === undefined ? {} : { currentVersion }),
  };
}

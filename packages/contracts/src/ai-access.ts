import { z } from "zod";
import { aiProviderIdSchema, type AiProviderId } from "./llm.js";
import type {
  AiBudgetStatus,
  AiMoneyReservation,
  AiUserBudgetStatus,
} from "./ai-budget.js";

export const aiPolicyIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const aiConsentSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("granted"), policyId: aiPolicyIdSchema }),
  z.object({ action: z.literal("revoked") }),
]);
export type AiConsentInput = z.infer<typeof aiConsentSchema>;
// Technical disclosure, not an operator-approved legal privacy notice.
export type AiPolicy = {
  id: string;
  version: string;
  provider: AiProviderId;
  model: string;
  recipient: string;
  routing: string;
  data: string;
};
export type AiAccess = {
  policy: AiPolicy | null;
  granted: boolean;
  dailyLimit: number;
  budget?: AiUserBudgetStatus;
};

const routingRevisionSchema = z.number().int().min(1).max(2147483647);
export const aiRoutingInputSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("disabled"),
    policyId: z.null(),
    expectedRevision: routingRevisionSchema,
  }),
  z.strictObject({
    provider: aiProviderIdSchema,
    policyId: aiPolicyIdSchema,
    expectedRevision: routingRevisionSchema,
  }),
]);
export type AiRoutingInput = z.infer<typeof aiRoutingInputSchema>;
export type AiRouting = {
  provider: AiProviderId | "disabled";
  policyId: string | null;
  revision: number;
};
export type AiRoutingAudit = {
  id: string;
  actorUserId: string | null;
  createdAt: string;
  payload: { from: AiRouting | null; to: AiRouting; policy: AiPolicy | null };
};
export type AiControlStatus = {
  current: AiRouting;
  effectiveProvider: AiProviderId | "unconfigured";
  environmentDisabled: boolean;
  automaticFallback: false;
  options: {
    provider: AiProviderId;
    policy: AiPolicy | null;
    unavailableReason:
      "not_configured" | "production_blocked" | "server_disabled" | null;
  }[];
  audit: AiRoutingAudit[];
  // Additive for older admin clients/servers. Never a billing statement.
  attempts?: AiAttemptOverview;
  budget?: AiBudgetStatus;
};

export type AiAttemptOverview = {
  day: string;
  reservedToday: number;
  userDailyLimit: number;
  globalDailyLimit: number;
  configurationMatches: boolean;
  pinnedLimits: { userDailyLimit: number; globalDailyLimit: number } | null;
  maxPerRequest: 2;
  recent: {
    userId: string;
    threadId: string;
    requestId: string;
    attemptNumber: number;
    provider: AiProviderId;
    model: string;
    routingRevision: number;
    reservedAt: string;
    requestStatus: "running" | "complete" | "interrupted";
    // Null/absent means historical attempt without a monetary assessment.
    money?: AiMoneyReservation | null;
  }[];
};

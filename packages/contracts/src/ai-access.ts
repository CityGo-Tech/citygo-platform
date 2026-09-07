import { z } from "zod";
import type { AiProviderId } from "./llm.js";

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
};

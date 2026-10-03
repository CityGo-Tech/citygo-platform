import { z } from "zod";
import type { AiProviderId, ModelGeneration } from "./llm.js";
import { aiPolicyIdSchema, type AiAccess } from "./ai-access.js";
import type { ApiErrorResponse } from "./protocol.js";

export const credentialsSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  password: z.string().min(12).max(128),
});
// Stored profiles remain valid after the move date has passed.
export const profileSchema = z.object({
  originCity: z.string().trim().min(2).max(100),
  targetCity: z.string().trim().min(2).max(100),
  monthlyBudget: z.number().int().min(5000).max(1000000),
  moveTargetDate: z.iso.date(),
  household: z.enum(["solo", "couple", "family"]),
  aiConsent: z.literal(true),
});
export const questionnaireSchema = profileSchema.refine(
  (v) => v.moveTargetDate >= new Date().toISOString().slice(0, 10),
  {
    path: ["moveTargetDate"],
    message: "Укажите сегодняшнюю или будущую дату",
  },
);
export type Questionnaire = z.infer<typeof questionnaireSchema>;
export const agentKeys = [
  "housing",
  "job-search",
  "resume-builder",
  "digital-mentor",
  "support",
] as const;
export const agentKeySchema = z.enum(agentKeys);
export type AgentKey = z.infer<typeof agentKeySchema>;
export const chatInputSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  requestId: z.uuid(),
  // Missing IDs from old clients fail closed at admission, without sending data.
  policyId: aiPolicyIdSchema.optional(),
});
// Concrete persisted plan version; this is NOT an R1 resource revision.
export const questPlanReferenceSchema = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(19),
  version: z.number().int().min(1).max(2147483647),
});
export type QuestPlanReference = z.infer<typeof questPlanReferenceSchema>;
export const questStartSchema = z.object({
  plan: questPlanReferenceSchema.optional(),
});
export const completionSchema = questStartSchema.extend({
  confirmed: z.literal(true),
});
export type Quest = {
  id: string;
  slug: string;
  title: string;
  state: "locked" | "available" | "in_progress" | "completed";
  xpReward: number;
  // Optional for old-server responses; the new server always supplies it.
  plan?: QuestPlanReference;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  agentKey: AgentKey;
  status: "complete" | "interrupted";
  generation?: ModelGeneration | null;
};
export type Dashboard = {
  user: { id: string; email: string };
  profile: Questionnaire | null;
  xp: number;
  quests: Quest[];
  thread: { id: string; agentKey: AgentKey; messages: Message[] } | null;
  provider: AiProviderId | "unconfigured";
  aiAccess: AiAccess;
};
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "handoff"; from: AgentKey; to: AgentKey; reason: string }
  | { type: "done"; messageId: string }
  | ({ type: "error"; message: string } & Omit<ApiErrorResponse, "error">);

import { z } from "zod";
import type { AiProviderId, ModelGeneration } from "./llm.js";
import { aiPolicyIdSchema, type AiAccess } from "./ai-access.js";
import type { ApiErrorResponse } from "./protocol.js";
import { aiModeIdSchema, aiModeCatalogIdSchema } from "./ai-modes.js";

const accountEmailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
export const registrationCredentialsSchema = z.object({
  email: accountEmailSchema,
  // Passwords are opaque: do not trim, normalize or require character classes.
  password: z.string().min(6).max(128),
});
// Kept for existing registration callers; login has separate validation so that
// a short bootstrap password can only be used to authenticate, not register.
export const credentialsSchema = registrationCredentialsSchema;
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1)
    .max(254)
    .refine(
      (value) =>
        z.email().safeParse(value).success ||
        /^[a-z0-9_.-]{1,64}$/i.test(value),
    )
    .transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});
export const accountRoleSchema = z.enum(["user", "admin", "super_admin"]);
export type AccountRole = z.infer<typeof accountRoleSchema>;
export const accountUserSchema = z.object({
  id: z.string().min(1).max(200).regex(/^\S+$/),
  email: z.email().max(254),
  // Additive for compatibility with older servers and persisted fixtures.
  username: z.string().min(1).max(64).nullable().optional(),
  role: accountRoleSchema.optional(),
  mustChangePassword: z.boolean().optional(),
  serviceConsentRequired: z.boolean().optional(),
});
export type AccountUser = z.infer<typeof accountUserSchema>;
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  password: z.string().min(6).max(128),
});
export const changeRoleSchema = z.object({
  userId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(19),
  role: accountRoleSchema,
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
// Numeric database IDs remain opaque strings, including values above 2^53.
export const conversationIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine(
    (value) =>
      /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  );
export const conversationStartSchema = z.strictObject({
  agentKey: agentKeySchema.optional(),
});
export const conversationFiltersSchema = z.strictObject({
  search: z.string().trim().min(1).max(160).optional(),
  assistantKey: agentKeySchema.optional(),
  status: z.enum(["active", "closed"]).optional(),
});
export type ConversationFilters = z.infer<typeof conversationFiltersSchema>;
export const conversationListQuerySchema = conversationFiltersSchema.extend({
  before: conversationIdSchema.optional(),
});
export type ConversationSummary = {
  // Optional for old servers/clients; null means the assistant default is used.
  customTitle?: string | null;
  titleRevision?: string;
  id: string;
  agentKey: AgentKey;
  assistantKey: AgentKey | null;
  closed: boolean;
  updatedAt: string;
  preview: string;
};
export type ConversationList = {
  userId: string;
  conversations: ConversationSummary[];
  nextCursor: string | null;
};
export const chatInputSchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
    requestId: z.uuid(),
    // Missing IDs from old clients fail closed at admission, without sending data.
    policyId: aiPolicyIdSchema.optional(),
    // Capability echo from the displayed balance. Old clients must not silently
    // acquire an overdraft they do not know how to render.
    creditReservationMode: z.enum(["full", "fixed5_overdraft"]).optional(),
    aiMode: aiModeIdSchema.optional(),
    aiModeCatalogId: aiModeCatalogIdSchema.optional(),
  })
  .refine(
    (value) =>
      (value.aiMode === undefined) === (value.aiModeCatalogId === undefined),
    "Mode and catalog identity must be submitted together",
  );
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
  favorite?: boolean;
  // Additive persisted reason for a proven refusal before any model dispatch.
  failureCode?: "AI_CREDIT_EXHAUSTED" | null;
};
export type Dashboard = {
  // New Web/API pairs opt in; older servers do not receive unknown reads.
  supportUpdatesAvailable?: boolean;
  assistantContextAvailable?: boolean;
  supportManagementAvailable?: boolean;
  user: AccountUser;
  profile: Questionnaire | null;
  xp: number;
  quests: Quest[];
  thread: {
    id: string;
    agentKey: AgentKey;
    assistantKey?: AgentKey | null;
    closed?: boolean;
    messages: Message[];
  } | null;
  provider: AiProviderId | "unconfigured";
  aiAccess: AiAccess;
};
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "handoff"; from: AgentKey; to: AgentKey; reason: string }
  | { type: "done"; messageId: string }
  | ({ type: "error"; message: string } & Omit<ApiErrorResponse, "error">);

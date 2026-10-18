import { z } from "zod";
import { aiCreditResponseSchema } from "./ai-credit.js";
import { errorMetadataSchema } from "./protocol.js";
export { apiErrorResponseSchema } from "./protocol.js";
import {
  accountUserSchema,
  agentKeySchema,
  profileSchema,
  questPlanReferenceSchema,
  type Dashboard,
  type StreamEvent,
} from "./platform.js";
import { aiProviderIdSchema } from "./llm.js";
import {
  aiPolicyIdSchema,
  type AiControlStatus,
  type AiRouting,
} from "./ai-access.js";
import {
  MAX_MONEY_MICROS,
  type AiBudgetSettings,
  type AiBudgetAuditSnapshot,
} from "./ai-budget.js";

// Response IDs are opaque strings (the current API also uses decimal IDs).
// Objects intentionally allow additive fields, but validate every known field.
const id = z.string().min(1).max(200).regex(/^\S+$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revision = count.refine((value) => value > 0);
const text = z.string().min(1).max(4096);
const money = count.max(MAX_MONEY_MICROS);
const currency = z.enum(["RUB", "USD"]);
const dateTime = z.iso.datetime({ offset: true });
// Existing audit endpoints expose PostgreSQL timestamp text; do not break old
// stored rows while adding validation. Keep the original presentation unchanged.
const auditTimestamp = z
  .string()
  .max(64)
  .refine(
    (value) =>
      dateTime.safeParse(
        value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
      ).success,
  );
const user = accountUserSchema;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export const authResponseSchema = z.object({
  user,
  token: z.string().min(1).max(4096).optional(),
});
export const nativeAuthResponseSchema = authResponseSchema.extend({
  token: z.string().min(1).max(4096),
});
export const adminUsersResponseSchema = z.object({
  users: z.array(accountUserSchema).max(200),
});
export const accountUserResponseSchema = z.object({ user: accountUserSchema });
export const startResponseSchema = z.object({ id });
export const completionResponseSchema = z.object({ awarded: count });

const policy = z.object({
  id: aiPolicyIdSchema,
  version: text,
  provider: aiProviderIdSchema,
  model: text,
  recipient: text,
  routing: text,
  data: text,
});
const execution = z.object({
  key: aiPolicyIdSchema,
  policy,
  maxInputBytes: count,
  maxOutputTokens: count,
});
const budgetSettingsFields = z.object({
  revision,
  enabled: z.boolean(),
  mode: z.enum(["fixed", "routerai_balance"]),
  currency: currency.nullable(),
  dailyLimitMicros: money.nullable(),
  totalLimitMicros: money.nullable(),
  userDailyLimitMicros: money.nullable(),
  rules: z.array(execution.extend({ attemptCeilingMicros: money })).max(3),
});
const validBudgetMode = (value: {
  mode?: "fixed" | "routerai_balance";
  currency: "RUB" | "USD" | null;
  dailyLimitMicros: number | null;
  totalLimitMicros: number | null;
}) =>
  value.mode === "routerai_balance"
    ? value.currency === "RUB" &&
      value.dailyLimitMicros === null &&
      value.totalLimitMicros === null
    : value.dailyLimitMicros !== null && value.totalLimitMicros !== null;
export const aiBudgetSettingsSchema = budgetSettingsFields.refine(
  validBudgetMode,
) satisfies z.ZodType<AiBudgetSettings>;
const budgetAuditSnapshot = budgetSettingsFields
  .extend({
    // Immutable snapshots predate personal caps and explicit operator mode.
    userDailyLimitMicros: money.nullable().optional(),
    mode: z.enum(["fixed", "routerai_balance"]).optional(),
  })
  .refine(validBudgetMode) satisfies z.ZodType<AiBudgetAuditSnapshot>;
const userBudget = z.object({
  currency: currency.nullable(),
  day: z.iso.date(),
  resetAt: dateTime,
  limitMicros: money.nullable(),
  reservedTodayMicros: count,
  remainingMicros: money.nullable(),
});
const budget = z.object({
  settings: aiBudgetSettingsSchema,
  totalReservedMicros: count,
  day: z.iso.date(),
  reservedTodayMicros: count,
  availableExecutions: z.array(execution).max(3),
  audit: z
    .array(
      z.object({
        id,
        actorUserId: id,
        createdAt: auditTimestamp,
        payload: z.object({
          from: budgetAuditSnapshot,
          to: budgetAuditSnapshot,
        }),
      }),
    )
    .max(1000),
});
export const aiRoutingResponseSchema = z.object({
  provider: aiProviderIdSchema.or(z.literal("disabled")),
  policyId: aiPolicyIdSchema.nullable(),
  revision,
}) satisfies z.ZodType<AiRouting>;
export const aiControlResponseSchema = z.object({
  current: aiRoutingResponseSchema,
  effectiveProvider: aiProviderIdSchema.or(z.literal("unconfigured")),
  environmentDisabled: z.boolean(),
  automaticFallback: z.literal(false),
  options: z
    .array(
      z.object({
        provider: aiProviderIdSchema,
        policy: policy.nullable(),
        unavailableReason: z
          .enum(["not_configured", "production_blocked", "server_disabled"])
          .nullable(),
      }),
    )
    .max(3),
  audit: z
    .array(
      z.object({
        id,
        actorUserId: id.nullable(),
        createdAt: auditTimestamp,
        payload: z.object({
          from: aiRoutingResponseSchema.nullable(),
          to: aiRoutingResponseSchema,
          policy: policy.nullable(),
        }),
      }),
    )
    .max(1000),
  budget: budget.optional(),
  attempts: z
    .object({
      day: z.iso.date(),
      reservedToday: count,
      userDailyLimit: count,
      globalDailyLimit: count,
      configurationMatches: z.boolean(),
      pinnedLimits: z
        .object({ userDailyLimit: count, globalDailyLimit: count })
        .nullable(),
      maxPerRequest: z.literal(2),
      recent: z
        .array(
          z.object({
            userId: id,
            threadId: id,
            requestId: id,
            attemptNumber: count,
            provider: aiProviderIdSchema,
            model: text,
            routingRevision: revision,
            reservedAt: dateTime,
            requestStatus: z.enum(["running", "complete", "interrupted"]),
            money: z
              .object({
                currency,
                amountMicros: money,
                revision,
                ruleKey: aiPolicyIdSchema,
              })
              .nullable()
              .optional(),
          }),
        )
        .max(1000),
    })
    .optional(),
}) satisfies z.ZodType<AiControlStatus>;

export const dashboardResponseSchema = z.object({
  user,
  profile: profileSchema.nullable(),
  xp: count,
  quests: z
    .array(
      z.object({
        id,
        slug: text,
        title: text,
        state: z.enum(["locked", "available", "in_progress", "completed"]),
        xpReward: count,
        plan: questPlanReferenceSchema.optional(),
      }),
    )
    .max(1000),
  thread: z
    .object({
      id,
      agentKey: agentKeySchema,
      messages: z
        .array(
          z.object({
            id,
            role: z.enum(["user", "assistant"]),
            content: z.string().max(1024 * 1024),
            agentKey: agentKeySchema,
            status: z.enum(["complete", "interrupted"]),
            generation: z
              .object({
                provider: aiProviderIdSchema,
                requestedModel: text,
                model: text.optional(),
                usage: z
                  .object({ inputTokens: count, outputTokens: count })
                  .optional(),
              })
              .nullable()
              .optional(),
          }),
        )
        .max(1000),
    })
    .nullable(),
  provider: aiProviderIdSchema.or(z.literal("unconfigured")),
  aiAccess: z.object({
    policy: policy.nullable(),
    granted: z.boolean(),
    dailyLimit: count,
    budget: userBudget.optional(),
    credit: aiCreditResponseSchema.optional(),
  }),
}) satisfies z.ZodType<Dashboard>;

export const adminOverviewResponseSchema = z.object({
  counts: z.object({ users: count, completed: count, xp: count }),
  pendingHuman: z
    .array(z.object({ id, thread_id: id, reason: text }))
    .max(1000),
});
export const streamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string().max(256 * 1024) }),
  z.object({
    type: z.literal("handoff"),
    from: agentKeySchema,
    to: agentKeySchema,
    reason: text,
  }),
  z.object({ type: z.literal("done"), messageId: id }),
  errorMetadataSchema.extend({
    type: z.literal("error"),
    message: z.string().min(1).max(2000),
  }),
]) satisfies z.ZodType<StreamEvent>;

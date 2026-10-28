import { z } from "zod";
import { accountRoleSchema } from "./platform.js";
import { CITYGO_MAX_AMOUNT_MICROS } from "./citygo-tariff.js";

export const customerAccountIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,17}(?![\s\S])/);
const time = z.iso.datetime();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const amount = z.number().int().min(0).max(CITYGO_MAX_AMOUNT_MICROS);
const signed = z
  .number()
  .int()
  .min(-CITYGO_MAX_AMOUNT_MICROS)
  .max(CITYGO_MAX_AMOUNT_MICROS);
const limit = (value: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(value);
export const customerAnalyticsIdSchema = z
  .string()
  .regex(/^cga_[a-f0-9]{64}(?![\s\S])/);
export const customerAnalyticsIdentityResponseSchema = z.strictObject({
  analyticsUserId: customerAnalyticsIdSchema.nullable(),
});

export const customerInteractionNameSchema = z.enum([
  "assistant_opened",
  "mode_selected",
  "favorite_added",
  "favorite_removed",
  "wallet_opened",
  "phone_opened",
  "profile_opened",
  "plan_opened",
  "conversation_opened",
  "ai_request_submitted",
  "payment_redirected",
]);
export const customerInteractionInputSchema = z.strictObject({
  event: customerInteractionNameSchema,
});
export const customerInteractionResponseSchema = z.strictObject({
  recorded: z.literal(true),
});
export type CustomerInteractionName = z.infer<
  typeof customerInteractionNameSchema
>;

export const adminCustomerAccountsQuerySchema = z.strictObject({
  search: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    )
    .optional(),
  afterUserId: customerAccountIdSchema.optional(),
  limit: limit(25, 50),
});
export const adminCustomerPageQuerySchema = z.strictObject({
  before: customerAccountIdSchema.optional(),
  limit: limit(25, 100),
});
export const adminCustomerMessagesQuerySchema = z.strictObject({
  before: customerAccountIdSchema.optional(),
  limit: limit(100, 100),
});
export const adminCustomerActivityQuerySchema = z.strictObject({
  before: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: limit(50, 100),
});
export const adminCustomerFunnelQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export const adminCustomerParamsSchema = z.strictObject({
  userId: customerAccountIdSchema,
});
export const adminCustomerConversationParamsSchema =
  adminCustomerParamsSchema.extend({ conversationId: customerAccountIdSchema });

export const adminCustomerSummarySchema = z.strictObject({
  userId: customerAccountIdSchema,
  email: z.email().max(254),
  username: z.string().max(64).nullable(),
  role: accountRoleSchema,
  status: z.enum(["active", "blocked", "deleted"]),
  createdAt: time,
  lastActivityAt: time,
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  giftClaimed: z.boolean(),
  availableMicros: signed,
  heldMicros: amount,
  spentMicros: amount,
  messageCount: count,
  conversationCount: count,
});
const ordered = (ids: string[], ascending: boolean) =>
  ids.every((id) => customerAccountIdSchema.safeParse(id).success) &&
  ids.every(
    (id, i) =>
      i === 0 ||
      (ascending
        ? BigInt(id) > BigInt(ids[i - 1]!)
        : BigInt(id) < BigInt(ids[i - 1]!)),
  );
export const adminCustomerAccountsResponseSchema = z
  .strictObject({
    accounts: z.array(adminCustomerSummarySchema).max(50),
    nextAfterUserId: customerAccountIdSchema.nullable(),
  })
  .refine(
    (p) =>
      ordered(
        p.accounts.map((x) => x.userId),
        true,
      ) &&
      (p.nextAfterUserId === null ||
        p.nextAfterUserId === p.accounts.at(-1)?.userId),
    "Некорректная страница аккаунтов",
  );
export const adminCustomerPlanItemSchema = z.strictObject({
  id: customerAccountIdSchema,
  title: z.string().min(1).max(120),
  details: z.string().max(4000),
  status: z.enum(["pending", "completed"]),
  createdAt: time,
  updatedAt: time,
});
export const adminCustomerPlanResponseSchema = z
  .strictObject({
    userId: customerAccountIdSchema,
    items: z.array(adminCustomerPlanItemSchema).max(100),
    nextBeforeId: customerAccountIdSchema.nullable(),
  })
  .refine(
    (p) =>
      ordered(
        p.items.map((x) => x.id),
        false,
      ) &&
      (p.nextBeforeId === null || p.nextBeforeId === p.items.at(-1)?.id),
    "Некорректная страница плана",
  );
export const adminCustomerAccountResponseSchema = z.strictObject({
  account: adminCustomerSummarySchema,
  analyticsUserId: customerAnalyticsIdSchema.nullable(),
  profile: z
    .strictObject({
      originCity: z.string().nullable(),
      targetCity: z.string(),
      monthlyBudget: z.string().nullable(),
      moveTargetDate: z.iso.date().nullable(),
    })
    .nullable(),
  personalPlan: z.strictObject({
    items: z.array(adminCustomerPlanItemSchema).max(50),
    nextBeforeId: customerAccountIdSchema.nullable(),
  }),
  favoritesCount: count,
  activeSessions: count,
});
export const adminCustomerConversationSchema = z.strictObject({
  id: customerAccountIdSchema,
  agentKey: z.string().min(1).max(100),
  assistantKey: z.string().min(1).max(100).nullable(),
  status: z.enum(["open", "closed", "handoff"]),
  createdAt: time,
  lastMessageAt: time.nullable(),
  messageCount: count,
});
export const adminCustomerConversationsResponseSchema = z
  .strictObject({
    userId: customerAccountIdSchema,
    conversations: z.array(adminCustomerConversationSchema).max(100),
    nextBeforeId: customerAccountIdSchema.nullable(),
  })
  .refine(
    (p) =>
      ordered(
        p.conversations.map((x) => x.id),
        false,
      ) &&
      (p.nextBeforeId === null ||
        p.nextBeforeId === p.conversations.at(-1)?.id),
    "Некорректная страница диалогов",
  );
export const adminCustomerMessageSchema = z.strictObject({
  id: customerAccountIdSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2_000_000),
  createdAt: time,
});
export const adminCustomerMessagesResponseSchema = z
  .strictObject({
    userId: customerAccountIdSchema,
    conversationId: customerAccountIdSchema,
    messages: z.array(adminCustomerMessageSchema).max(100),
    nextBeforeId: customerAccountIdSchema.nullable(),
  })
  .refine(
    (p) =>
      ordered(
        p.messages.map((x) => x.id),
        true,
      ) &&
      (p.nextBeforeId === null || p.nextBeforeId === p.messages[0]?.id),
    "Некорректная страница сообщений",
  );
export const adminCustomerFavoriteSchema = adminCustomerMessageSchema.extend({
  messageId: customerAccountIdSchema,
  conversationId: customerAccountIdSchema,
});
export const adminCustomerFavoritesResponseSchema = z
  .strictObject({
    userId: customerAccountIdSchema,
    items: z.array(adminCustomerFavoriteSchema).max(100),
    nextBeforeId: customerAccountIdSchema.nullable(),
  })
  .refine(
    (p) =>
      ordered(
        p.items.map((x) => x.id),
        false,
      ) &&
      p.items.every((x) => x.id === x.messageId) &&
      (p.nextBeforeId === null || p.nextBeforeId === p.items.at(-1)?.id),
    "Некорректная страница избранного",
  );
export const adminCustomerActivityEventSchema = z.strictObject({
  id: z.string().min(1).max(100),
  kind: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  occurredAt: time,
  conversationId: customerAccountIdSchema.nullable(),
  messageId: customerAccountIdSchema.nullable(),
  amountMicros: amount.nullable(),
});
export const adminCustomerActivityResponseSchema = z.strictObject({
  userId: customerAccountIdSchema,
  events: z.array(adminCustomerActivityEventSchema).max(100),
  nextCursor: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .nullable(),
});
export const adminCustomerFunnelResponseSchema = z.strictObject({
  days: z.number().int().min(1).max(90),
  from: time,
  to: time,
  basis: z.literal("registered_cohort"),
  steps: z
    .array(
      z.strictObject({
        key: z.string().max(80),
        label: z.string().max(120),
        users: count,
      }),
    )
    .max(12),
  recentActivity: z
    .array(
      z.strictObject({
        day: z.iso.date(),
        activeUsers: count,
        userMessages: count,
        assistantMessages: count,
        paidMicros: amount,
      }),
    )
    .max(91),
});

export type AdminCustomerAccountsQuery = z.infer<
  typeof adminCustomerAccountsQuerySchema
>;
export type AdminCustomerPageQuery = z.infer<
  typeof adminCustomerPageQuerySchema
>;
export type AdminCustomerActivityQuery = z.infer<
  typeof adminCustomerActivityQuerySchema
>;
export type AdminCustomerSummary = z.infer<typeof adminCustomerSummarySchema>;
export type AdminCustomerAccountsPage = z.infer<
  typeof adminCustomerAccountsResponseSchema
>;
export type AdminCustomerAccount = z.infer<
  typeof adminCustomerAccountResponseSchema
>;
export type AdminCustomerConversationsPage = z.infer<
  typeof adminCustomerConversationsResponseSchema
>;
export type AdminCustomerMessagesPage = z.infer<
  typeof adminCustomerMessagesResponseSchema
>;
export type AdminCustomerFavoritesPage = z.infer<
  typeof adminCustomerFavoritesResponseSchema
>;
export type AdminCustomerPlanPage = z.infer<
  typeof adminCustomerPlanResponseSchema
>;
export type AdminCustomerActivityPage = z.infer<
  typeof adminCustomerActivityResponseSchema
>;
export type AdminCustomerFunnel = z.infer<
  typeof adminCustomerFunnelResponseSchema
>;

import {
  adminCustomerAccountsQuerySchema,
  adminCustomerPageQuerySchema,
  adminCustomerMessagesQuerySchema,
  adminCustomerActivityQuerySchema,
  adminCustomerFunnelQuerySchema,
  adminCustomerAccountsResponseSchema,
  adminCustomerAccountResponseSchema,
  adminCustomerConversationsResponseSchema,
  adminCustomerMessagesResponseSchema,
  adminCustomerFavoritesResponseSchema,
  adminCustomerPlanResponseSchema,
  adminCustomerActivityResponseSchema,
  adminCustomerFunnelResponseSchema,
  customerAccountIdSchema,
  customerAnalyticsIdentityResponseSchema,
  customerInteractionInputSchema,
  customerInteractionResponseSchema,
  type AdminCustomerAccountsQuery,
  type AdminCustomerPageQuery,
  type AdminCustomerActivityQuery,
  type CustomerInteractionName,
} from "@citygo/contracts";
import { ApiError } from "./transport.js";

type Schema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};
type Request = <T>(
  path: string,
  schema: Schema<T>,
  body?: unknown,
) => Promise<T>;

function input<T>(schema: Schema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error("Некорректный запрос просмотра пользователя");
  return parsed.data;
}
function expected(value: unknown): asserts value {
  if (!value)
    throw new ApiError(
      200,
      "Ответ сервера не соответствует запрошенному пользователю или странице",
      "invalid_response",
    );
}
function search(value: Record<string, string | number | undefined>) {
  const result = new URLSearchParams();
  for (const [key, item] of Object.entries(value))
    if (item !== undefined) result.set(key, String(item));
  return result.size ? "?" + result.toString() : "";
}
function pageIds(
  ids: string[],
  limit: number,
  next: string | null,
  before: string | undefined,
  ascending: boolean,
) {
  expected(ids.length <= limit && new Set(ids).size === ids.length);
  expected(
    ids.every(
      (id, index) =>
        (!before || BigInt(id) < BigInt(before)) &&
        (index === 0 ||
          (ascending
            ? BigInt(ids[index - 1]!) < BigInt(id)
            : BigInt(ids[index - 1]!) > BigInt(id))),
    ),
  );
  if (next !== null)
    expected(ids.length > 0 && next === (ascending ? ids[0] : ids.at(-1)));
}

export function createAdminCustomerMethods(request: Request) {
  const accountPath = (value: string) =>
    "/v1/admin/customer-accounts/" +
    encodeURIComponent(input(customerAccountIdSchema, value));
  return {
    adminCustomerAccounts: async (
      value: Partial<AdminCustomerAccountsQuery> = {},
    ) => {
      const query = input(adminCustomerAccountsQuerySchema, value);
      const page = await request(
        "/v1/admin/customer-accounts" + search(query),
        adminCustomerAccountsResponseSchema,
      );
      const ids = page.accounts.map((account) => account.userId);
      expected(ids.length <= query.limit && new Set(ids).size === ids.length);
      expected(
        ids.every(
          (id, index) =>
            (!query.afterUserId || BigInt(id) > BigInt(query.afterUserId)) &&
            (index === 0 || BigInt(ids[index - 1]!) < BigInt(id)),
        ),
      );
      if (page.nextAfterUserId !== null)
        expected(ids.length > 0 && page.nextAfterUserId === ids.at(-1));
      return page;
    },
    adminCustomerAccount: async (userId: string) => {
      const path = accountPath(userId);
      const account = await request(path, adminCustomerAccountResponseSchema);
      expected(account.account.userId === userId);
      return account;
    },
    adminCustomerConversations: async (
      userId: string,
      value: Partial<AdminCustomerPageQuery> = {},
    ) => {
      const query = input(adminCustomerPageQuerySchema, value);
      const page = await request(
        accountPath(userId) + "/conversations" + search(query),
        adminCustomerConversationsResponseSchema,
      );
      expected(page.userId === userId);
      pageIds(
        page.conversations.map((item) => item.id),
        query.limit,
        page.nextBeforeId,
        query.before,
        false,
      );
      return page;
    },
    adminCustomerMessages: async (
      userId: string,
      conversationId: string,
      value: Partial<AdminCustomerPageQuery> = {},
    ) => {
      const query = input(adminCustomerMessagesQuerySchema, value);
      const id = input(customerAccountIdSchema, conversationId);
      const page = await request(
        accountPath(userId) +
          "/conversations/" +
          encodeURIComponent(id) +
          "/messages" +
          search(query),
        adminCustomerMessagesResponseSchema,
      );
      expected(page.userId === userId && page.conversationId === id);
      pageIds(
        page.messages.map((item) => item.id),
        query.limit,
        page.nextBeforeId,
        query.before,
        true,
      );
      return page;
    },
    adminCustomerPlan: async (
      userId: string,
      value: Partial<AdminCustomerPageQuery> = {},
    ) => {
      const query = input(adminCustomerPageQuerySchema, value);
      const page = await request(
        accountPath(userId) + "/plan" + search(query),
        adminCustomerPlanResponseSchema,
      );
      expected(page.userId === userId);
      pageIds(
        page.items.map((item) => item.id),
        query.limit,
        page.nextBeforeId,
        query.before,
        false,
      );
      return page;
    },
    adminCustomerFavorites: async (
      userId: string,
      value: Partial<AdminCustomerPageQuery> = {},
    ) => {
      const query = input(adminCustomerPageQuerySchema, value);
      const page = await request(
        accountPath(userId) + "/favorites" + search(query),
        adminCustomerFavoritesResponseSchema,
      );
      expected(
        page.userId === userId &&
          page.items.every((item) => item.id === item.messageId),
      );
      pageIds(
        page.items.map((item) => item.id),
        query.limit,
        page.nextBeforeId,
        query.before,
        false,
      );
      return page;
    },
    adminCustomerActivity: async (
      userId: string,
      value: Partial<AdminCustomerActivityQuery> = {},
    ) => {
      const query = input(adminCustomerActivityQuerySchema, value);
      const page = await request(
        accountPath(userId) + "/activity" + search(query),
        adminCustomerActivityResponseSchema,
      );
      expected(page.userId === userId && page.events.length <= query.limit);
      expected(
        new Set(page.events.map((event) => event.id)).size ===
          page.events.length,
      );
      expected(
        page.events.every(
          (event, index) =>
            index === 0 ||
            Date.parse(page.events[index - 1]!.occurredAt) >=
              Date.parse(event.occurredAt),
        ),
      );
      expected(
        page.nextCursor === null ||
          (page.events.length > 0 && page.nextCursor !== query.before),
      );
      return page;
    },
    adminCustomerFunnel: async (value: { days?: number } = {}) => {
      const query = input(adminCustomerFunnelQuerySchema, value);
      const funnel = await request(
        "/v1/admin/customer-funnel" + search(query),
        adminCustomerFunnelResponseSchema,
      );
      expected(
        funnel.days === query.days &&
          Date.parse(funnel.from) <= Date.parse(funnel.to),
      );
      expected(
        new Set(funnel.steps.map((step) => step.key)).size ===
          funnel.steps.length,
      );
      return funnel;
    },
    analyticsIdentity: () =>
      request(
        "/v1/analytics/identity",
        customerAnalyticsIdentityResponseSchema,
      ),
    recordProductEvent: async (event: CustomerInteractionName) =>
      request(
        "/v1/analytics/events",
        customerInteractionResponseSchema,
        input(customerInteractionInputSchema, { event }),
      ),
  };
}

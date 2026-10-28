import { createHmac, hkdfSync } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CustomerObservability,
  type CustomerObservabilityContext,
  type Database,
} from "@citygo/db";
import {
  adminCustomerAccountsQuerySchema,
  adminCustomerAccountsResponseSchema,
  adminCustomerParamsSchema,
  adminCustomerConversationParamsSchema,
  adminCustomerAccountResponseSchema,
  adminCustomerPageQuerySchema,
  adminCustomerConversationsResponseSchema,
  adminCustomerMessagesQuerySchema,
  adminCustomerMessagesResponseSchema,
  adminCustomerFavoritesResponseSchema,
  adminCustomerPlanResponseSchema,
  adminCustomerActivityQuerySchema,
  adminCustomerActivityResponseSchema,
  adminCustomerFunnelQuerySchema,
  adminCustomerFunnelResponseSchema,
  customerAnalyticsIdentityResponseSchema,
  customerInteractionInputSchema,
  customerInteractionResponseSchema,
} from "@citygo/contracts";

/** Search terms may be contact details. Log request paths, never query values. */
export function serializeRequestLog(
  request: Pick<FastifyRequest, "method" | "url" | "hostname" | "ip">,
) {
  return {
    method: request.method,
    url: request.url.split("?", 1)[0],
    host: request.hostname,
    remoteAddress: request.ip,
  };
}

export function customerAnalyticsId(userId: string, secret?: string) {
  if (!secret) return null;
  // Domain-separated from phone proof/envelope keys. Neither raw account IDs,
  // contact details nor the derivation key is transmitted to the counter.
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      "citygo-purpose-keys-v1",
      "metrika-account-id-v1",
      32,
    ),
  );
  try {
    return "cga_" + createHmac("sha256", key).update(userId).digest("hex");
  } finally {
    key.fill(0);
  }
}

export function registerCustomerObservability(
  app: FastifyInstance,
  options: {
    db: Database;
    phoneVerificationSecret?: string;
    context: (request: FastifyRequest) => Promise<CustomerObservabilityContext>;
  },
) {
  const store = new CustomerObservability(options.db);
  app.get("/v1/admin/customer-accounts", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const ctx = await options.context(request);
    return adminCustomerAccountsResponseSchema.parse(
      await store.list(
        ctx,
        adminCustomerAccountsQuerySchema.parse(request.query),
      ),
    );
  });
  app.get("/v1/admin/customer-accounts/:userId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const ctx = await options.context(request),
      { userId } = adminCustomerParamsSchema.parse(request.params);
    const value = await store.detail(ctx, userId);
    return adminCustomerAccountResponseSchema.parse({
      ...value,
      analyticsUserId: customerAnalyticsId(
        userId,
        options.phoneVerificationSecret,
      ),
    });
  });
  app.get(
    "/v1/admin/customer-accounts/:userId/conversations",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const ctx = await options.context(request),
        { userId } = adminCustomerParamsSchema.parse(request.params);
      return adminCustomerConversationsResponseSchema.parse(
        await store.conversations(
          ctx,
          userId,
          adminCustomerPageQuerySchema.parse(request.query),
        ),
      );
    },
  );
  app.get(
    "/v1/admin/customer-accounts/:userId/conversations/:conversationId/messages",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const ctx = await options.context(request),
        { userId, conversationId } =
          adminCustomerConversationParamsSchema.parse(request.params);
      return adminCustomerMessagesResponseSchema.parse(
        await store.messages(
          ctx,
          userId,
          conversationId,
          adminCustomerMessagesQuerySchema.parse(request.query),
        ),
      );
    },
  );
  app.get(
    "/v1/admin/customer-accounts/:userId/favorites",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const ctx = await options.context(request),
        { userId } = adminCustomerParamsSchema.parse(request.params);
      return adminCustomerFavoritesResponseSchema.parse(
        await store.favorites(
          ctx,
          userId,
          adminCustomerPageQuerySchema.parse(request.query),
        ),
      );
    },
  );
  app.get(
    "/v1/admin/customer-accounts/:userId/plan",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const ctx = await options.context(request),
        { userId } = adminCustomerParamsSchema.parse(request.params);
      return adminCustomerPlanResponseSchema.parse(
        await store.plan(
          ctx,
          userId,
          adminCustomerPageQuerySchema.parse(request.query),
        ),
      );
    },
  );
  app.get(
    "/v1/admin/customer-accounts/:userId/activity",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const ctx = await options.context(request),
        { userId } = adminCustomerParamsSchema.parse(request.params);
      return adminCustomerActivityResponseSchema.parse(
        await store.activity(
          ctx,
          userId,
          adminCustomerActivityQuerySchema.parse(request.query),
        ),
      );
    },
  );
  app.get("/v1/admin/customer-funnel", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const ctx = await options.context(request);
    return adminCustomerFunnelResponseSchema.parse(
      await store.funnel(
        ctx,
        adminCustomerFunnelQuerySchema.parse(request.query),
      ),
    );
  });
  app.get("/v1/analytics/identity", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const ctx = await options.context(request);
    const userId = await store.checkIdentity(ctx);
    return customerAnalyticsIdentityResponseSchema.parse({
      analyticsUserId: customerAnalyticsId(
        userId,
        options.phoneVerificationSecret,
      ),
    });
  });
  app.post(
    "/v1/analytics/events",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const ctx = await options.context(request);
      return customerInteractionResponseSchema.parse(
        await store.recordInteraction(
          ctx,
          customerInteractionInputSchema.parse(request.body),
        ),
      );
    },
  );
}

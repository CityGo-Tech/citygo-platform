import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  supportRequestIdSchema,
  createSupportRequestSchema,
  supportRequestsQuerySchema,
  supportRequestResultSchema,
  supportRequestsPageSchema,
  adminSupportRequestResultSchema,
  adminSupportRequestsPageSchema,
  updateSupportRequestStatusSchema,
  supportRepliesQuerySchema,
  supportRepliesPageSchema,
  adminSupportRepliesPageSchema,
  createSupportReplySchema,
  supportReplyResultSchema,
  supportUpdatesQuerySchema,
  supportUpdatesPageSchema,
  markSupportRepliesReadSchema,
  supportReadResultSchema,
} from "@citygo/contracts";
import {
  HumanSupportRequests,
  type HumanSupportContext,
  type Database,
} from "@citygo/db";

export function registerHumanSupportApi(
  app: FastifyInstance,
  options: {
    db: Database;
    context: (request: FastifyRequest) => Promise<HumanSupportContext>;
  },
) {
  const store = new HumanSupportRequests(options.db);
  const params = z.strictObject({ id: supportRequestIdSchema });
  const read = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  app.get("/v1/support-updates", read, async (request) =>
    supportUpdatesPageSchema.parse(
      await store.updates(
        await options.context(request),
        supportUpdatesQuerySchema.parse(request.query),
      ),
    ),
  );
  app.get("/v1/support-requests/:id", read, async (request) => {
    z.strictObject({}).parse(request.query);
    return supportRequestResultSchema.parse(
      await store.detail(
        await options.context(request),
        params.parse(request.params).id,
        false,
      ),
    );
  });
  app.post(
    "/v1/support-requests/:id/read",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request) => {
      z.strictObject({}).parse(request.query);
      return supportReadResultSchema.parse(
        await store.markRead(
          await options.context(request),
          params.parse(request.params).id,
          markSupportRepliesReadSchema.parse(request.body),
        ),
      );
    },
  );
  app.patch(
    "/v1/support-requests/:id",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request) => {
      z.strictObject({}).parse(request.query);
      return supportRequestResultSchema.parse(
        await store.setOwnStatus(
          await options.context(request),
          params.parse(request.params).id,
          updateSupportRequestStatusSchema.parse(request.body),
        ),
      );
    },
  );
  app.get("/v1/support-requests/:id/replies", read, async (request) =>
    supportRepliesPageSchema.parse(
      await store.replies(
        await options.context(request),
        params.parse(request.params).id,
        supportRepliesQuerySchema.parse(request.query),
      ),
    ),
  );
  app.get("/v1/admin/support-requests/:id/replies", read, async (request) =>
    adminSupportRepliesPageSchema.parse(
      await store.replies(
        await options.context(request),
        params.parse(request.params).id,
        supportRepliesQuerySchema.parse(request.query),
        true,
      ),
    ),
  );
  app.post(
    "/v1/admin/support-requests/:id/replies",
    { config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (request) => {
      z.strictObject({}).parse(request.query);
      return supportReplyResultSchema.parse(
        await store.reply(
          await options.context(request),
          params.parse(request.params).id,
          createSupportReplySchema.parse(request.body),
        ),
      );
    },
  );
  app.get("/v1/support-requests", read, async (request) =>
    supportRequestsPageSchema.parse(
      await store.list(
        await options.context(request),
        supportRequestsQuerySchema.parse(request.query),
      ),
    ),
  );
  app.post(
    "/v1/support-requests",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request) => {
      z.strictObject({}).parse(request.query);
      return supportRequestResultSchema.parse(
        await store.create(
          await options.context(request),
          createSupportRequestSchema.parse(request.body),
        ),
      );
    },
  );
  app.get("/v1/admin/support-requests", read, async (request) =>
    adminSupportRequestsPageSchema.parse(
      await store.list(
        await options.context(request),
        supportRequestsQuerySchema.parse(request.query),
        true,
      ),
    ),
  );
  app.get("/v1/admin/support-requests/:id", read, async (request) => {
    z.strictObject({}).parse(request.query);
    return adminSupportRequestResultSchema.parse(
      await store.detail(
        await options.context(request),
        params.parse(request.params).id,
      ),
    );
  });
  app.patch(
    "/v1/admin/support-requests/:id",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request) => {
      z.strictObject({}).parse(request.query);
      return adminSupportRequestResultSchema.parse(
        await store.setStatus(
          await options.context(request),
          params.parse(request.params).id,
          updateSupportRequestStatusSchema.parse(request.body),
        ),
      );
    },
  );
}

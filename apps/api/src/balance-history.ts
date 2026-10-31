import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  balanceHistoryQuerySchema,
  balanceHistoryPageSchema,
} from "@citygo/contracts";
import {
  BalanceHistory,
  type BalanceHistoryContext,
  type Database,
} from "@citygo/db";
export function registerBalanceHistoryApi(
  app: FastifyInstance,
  options: {
    db: Database;
    context: (request: FastifyRequest) => Promise<BalanceHistoryContext>;
  },
) {
  const store = new BalanceHistory(options.db);
  app.get(
    "/v1/ai/credit/history",
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return balanceHistoryPageSchema.parse(
        await store.list(
          await options.context(request),
          balanceHistoryQuerySchema.parse(request.query),
        ),
      );
    },
  );
}

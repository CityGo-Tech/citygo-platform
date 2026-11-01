import type { FastifyInstance, FastifyRequest } from "fastify";
import { exportConversation, DomainError, type Database } from "@citygo/db";
import {
  conversationExportParamsSchema,
  conversationExportQuerySchema,
  conversationExportSchema,
} from "@citygo/contracts";

export function registerConversationExport(
  app: FastifyInstance,
  db: Database,
  authenticate: (request: FastifyRequest) => Promise<{ id: string }>,
) {
  app.get(
    "/v1/conversations/:id/export",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const user = await authenticate(request);
      const params = conversationExportParamsSchema.safeParse(request.params);
      const query = conversationExportQuerySchema.safeParse(request.query);
      if (!params.success || !query.success)
        throw new DomainError(400, "Проверьте параметры выгрузки диалога");
      const snapshot = await exportConversation(db, user.id, params.data.id);
      // Revoked sessions, blocked/bootstrap users and account changes must fail
      // before personal text leaves the API, including while the DB read waited.
      const current = await authenticate(request);
      if (current.id !== user.id)
        throw new DomainError(401, "Войдите в аккаунт заново");
      const result = conversationExportSchema.safeParse(snapshot);
      if (
        !result.success ||
        result.data.userId !== user.id ||
        result.data.thread.id !== params.data.id
      )
        throw new Error("Invalid stored conversation export");
      return result.data;
    },
  );
}

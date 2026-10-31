import type { FastifyInstance, FastifyRequest } from "fastify";
import { ConversationMessageSearch, type Database } from "@citygo/db";
import {
  conversationHistoryIdSchema,
  conversationMessageSearchQuerySchema,
} from "@citygo/contracts";
export function registerConversationMessageSearch(
  app: FastifyInstance,
  db: Database,
  authenticate: (request: FastifyRequest) => Promise<{ id: string }>,
) {
  const search = new ConversationMessageSearch(db);
  app.get("/v1/conversations/:id/messages/search", async (request, reply) => {
    const user = await authenticate(request);
    const id = conversationHistoryIdSchema.parse(
      (request.params as { id: string }).id,
    );
    const query = conversationMessageSearchQuerySchema.parse(request.query);
    reply.header("Cache-Control", "no-store");
    return search.list(user.id, id, query);
  });
}

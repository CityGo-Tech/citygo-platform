import type { FastifyInstance, FastifyRequest } from "fastify";
import { ConversationTitles, type Database } from "@citygo/db";
import {
  conversationIdSchema,
  updateConversationTitleSchema,
} from "@citygo/contracts";
export function registerConversationTitles(
  app: FastifyInstance,
  db: Database,
  authenticate: (request: FastifyRequest) => Promise<{ id: string }>,
) {
  const titles = new ConversationTitles(db);
  app.get("/v1/conversations/:id/title", async (request, reply) => {
    const owner = await authenticate(request);
    const id = conversationIdSchema.parse(
      (request.params as { id: string }).id,
    );
    reply.header("Cache-Control", "no-store");
    return titles.get(owner.id, id);
  });
  app.patch("/v1/conversations/:id/title", async (request, reply) => {
    const owner = await authenticate(request);
    const id = conversationIdSchema.parse(
      (request.params as { id: string }).id,
    );
    const input = updateConversationTitleSchema.parse(request.body);
    reply.header("Cache-Control", "no-store");
    return titles.update(owner.id, id, input);
  });
}

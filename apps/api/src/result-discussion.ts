import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  resultDiscussionParamsSchema,
  resultDiscussionSourceSchema,
} from "@citygo/contracts";
import {
  readResultDiscussionSource,
  DomainError,
  type Database,
} from "@citygo/db";

export function registerResultDiscussionApi(
  app: FastifyInstance,
  db: Database,
  authenticate: (request: FastifyRequest) => Promise<{ id: string }>,
) {
  app.get(
    "/v1/results/:kind/:id/discussion-source",
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request, reply) => {
      const user = await authenticate(request);
      const params = resultDiscussionParamsSchema.safeParse(request.params);
      if (
        !params.success ||
        !z.strictObject({}).safeParse(request.query).success
      )
        throw new DomainError(400, "Проверьте выбранный результат");
      reply.header("Cache-Control", "no-store");
      let source;
      try {
        source = await readResultDiscussionSource(db, user.id, params.data);
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new Error("Invalid saved result");
        throw error;
      }
      const current = await authenticate(request);
      const parsed = resultDiscussionSourceSchema.safeParse(source);
      if (
        !parsed.success ||
        current.id !== user.id ||
        parsed.data.userId !== user.id ||
        parsed.data.kind !== params.data.kind ||
        parsed.data.id !== params.data.id
      )
        throw new Error("Invalid result source response");
      return parsed.data;
    },
  );
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  knowledgeEntityIdSchema,
  knowledgeEntityKindSchema,
  knowledgeFactCandidateRequestSchema,
  knowledgeLookupRequestSchema,
  knowledgePublishRequestSchema,
  knowledgeRevisionRequestSchema,
  knowledgeSourceCandidateRequestSchema,
} from "@citygo/contracts";
import {
  DomainError,
  KnowledgeEditorialStore,
  type Database,
} from "@citygo/db";

type Actor = {
  id: string;
  role: "user" | "admin" | "super_admin";
};
type Authenticate = (request: FastifyRequest) => Promise<Actor>;

const target = z.strictObject({
  kind: knowledgeEntityKindSchema,
  id: knowledgeEntityIdSchema,
});
const historyQuery = z.strictObject({
  revision: z
    .string()
    .regex(/^[1-9]\d{0,15}$/)
    .transform(Number)
    .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .optional(),
});
const noQuery = z.strictObject({});
const editorialPath = "/v1/admin/knowledge/:kind/:id";

function readInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const input = schema.safeParse(value);
  if (!input.success)
    throw new DomainError(400, "Проверьте параметры базы знаний");
  return input.data;
}

export function registerKnowledgeEditorialApi(
  app: FastifyInstance,
  options: {
    db: Database;
    authenticate: Authenticate;
    authenticateAdmin: Authenticate;
  },
) {
  const store = new KnowledgeEditorialStore(options.db);

  app.post(
    "/v1/knowledge/lookup",
    { bodyLimit: 2048, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request) => {
      await options.authenticate(request);
      readInput(noQuery, request.query);
      return store.lookup(
        readInput(knowledgeLookupRequestSchema, request.body),
      );
    },
  );

  app.get(
    editorialPath,
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request) => {
      const actor = await options.authenticateAdmin(request);
      const { kind, id } = readInput(target, request.params);
      const { revision } = readInput(historyQuery, request.query);
      return store.editorial(actor.id, kind, id, revision);
    },
  );

  function write(
    action: "candidate" | "publish" | "stale" | "withdraw",
    bodyLimit = 2048,
  ) {
    app.post(
      editorialPath + "/" + action,
      { bodyLimit, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
      async (request, reply) => {
        const actor = await options.authenticateAdmin(request);
        if (action === "withdraw" && actor.role !== "super_admin")
          throw new DomainError(
            403,
            "Отзывать записи может супер-администратор",
          );
        readInput(noQuery, request.query);
        const { kind, id } = readInput(target, request.params);
        if (action === "candidate") {
          const input =
            kind === "source"
              ? readInput(knowledgeSourceCandidateRequestSchema, request.body)
              : readInput(knowledgeFactCandidateRequestSchema, request.body);
          const result = await store.propose(actor.id, kind, id, input);
          return reply.code(201).send(result);
        }
        if (action === "publish")
          return store.publish(
            actor.id,
            kind,
            id,
            readInput(knowledgePublishRequestSchema, request.body),
          );
        const input = readInput(knowledgeRevisionRequestSchema, request.body);
        return action === "stale"
          ? store.markStale(actor.id, kind, id, input)
          : store.withdraw(actor.id, kind, id, input);
      },
    );
  }
  // Eight quotes of up to 4,000 code units plus the statement and JSON escaping.
  write("candidate", 256 * 1024);
  write("publish");
  write("stale");
  write("withdraw");
}

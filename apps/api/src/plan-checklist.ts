import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  personalPlanIdSchema,
  planChecklistSchema,
  savePlanChecklistSchema,
} from "@citygo/contracts";
import { PlanChecklists, DomainError, type Database } from "@citygo/db";
const params = z.strictObject({ id: personalPlanIdSchema });
const empty = z.strictObject({});
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError(400, "Проверьте пункты чек-листа");
  return parsed.data;
}
export function registerPlanChecklistApi(
  app: FastifyInstance,
  options: {
    db: Database;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
  },
) {
  const store = new PlanChecklists(options.db);
  for (const method of ["GET", "PUT"] as const)
    app.route({
      method,
      ...(method === "PUT" ? { bodyLimit: 256 * 1024 } : {}),
      url: "/v1/personal-plan/:id/checklist",
      config: {
        rateLimit: { max: method === "GET" ? 60 : 30, timeWindow: 60000 },
      },
      handler: async (request) => {
        const owner = await options.authenticate(request);
        const { id } = input(params, request.params);
        input(empty, request.query);
        const result =
          method === "GET"
            ? await store.get(owner.id, id)
            : await store.save(
                owner.id,
                id,
                input(savePlanChecklistSchema, request.body),
              );
        const parsed = planChecklistSchema.safeParse(result);
        if (
          !parsed.success ||
          parsed.data.userId !== owner.id ||
          parsed.data.itemId !== id
        )
          throw new Error("Invalid private checklist response");
        return parsed.data;
      },
    });
}

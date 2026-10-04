import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  housingGetQuerySchema,
  housingHistoryQuerySchema,
  housingListQuerySchema,
  housingRecoveryQuerySchema,
  housingParamsSchema,
  housingSnapshotResponseSchema,
  housingListResponseSchema,
  housingRecoveryResponseSchema,
  housingHistoryResponseSchema,
  r1HousingBriefCreateCommandV1Schema,
  r1HousingAnswerCommandV1Schema,
  type HousingStorageLimits,
} from "@citygo/contracts";
import {
  HousingAnswers,
  verifyHousingReadiness,
  DomainError,
  type Database,
} from "@citygo/db";

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DomainError(400, "Некорректный запрос брифа");
  return parsed.data;
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  // Never treat a server result failure as a user's Zod/400 error.
  if (!parsed.success) throw new Error("Invalid housing response");
  return parsed.data;
}

export function registerSyntheticHousingApi(
  app: FastifyInstance,
  options: {
    db: Database;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
    limits?: Partial<HousingStorageLimits>;
  },
) {
  const store = new HousingAnswers(options.db, options.limits);
  async function owner(request: FastifyRequest) {
    const user = await options.authenticate(request);
    // No bypass by spoofed body owner/admin, and no stale readiness cache.
    await verifyHousingReadiness(options.db);
    return user.id;
  }
  app.get("/v1/housing/briefs", async (request) => {
    const user = await owner(request);
    const { planId, planVersion, ...page } = input(
      housingListQuerySchema,
      request.query,
    );
    return output(
      housingListResponseSchema,
      await store.listSelectionForPlan(
        user,
        { id: planId, version: planVersion },
        page,
      ),
    );
  });
  app.get("/v1/housing/briefs/recovery", async (request) => {
    const user = await owner(request);
    const { planId, planVersion } = input(
      housingRecoveryQuerySchema,
      request.query,
    );
    return output(
      housingRecoveryResponseSchema,
      await store.recoverForPlan(user, { id: planId, version: planVersion }),
    );
  });
  app.get("/v1/housing/briefs/:id/history", async (request) => {
    const user = await owner(request);
    const { id } = input(housingParamsSchema, request.params);
    const page = input(housingHistoryQuerySchema, request.query);
    return output(
      housingHistoryResponseSchema,
      await store.history(user, id, page),
    );
  });
  app.get("/v1/housing/briefs/:id", async (request) => {
    const user = await owner(request);
    const { id } = input(housingParamsSchema, request.params);
    const { revision } = input(housingGetQuerySchema, request.query);
    return output(
      housingSnapshotResponseSchema,
      await store.get(user, id, revision),
    );
  });
  app.post("/v1/housing/briefs", async (request) => {
    const user = await owner(request);
    const command = input(r1HousingBriefCreateCommandV1Schema, request.body);
    return output(
      housingSnapshotResponseSchema,
      await store.create(user, command),
    );
  });
  app.post("/v1/housing/answers", async (request) => {
    const user = await owner(request);
    const command = input(r1HousingAnswerCommandV1Schema, request.body);
    return output(
      housingSnapshotResponseSchema,
      await store.stateAnswer(user, command),
    );
  });
}

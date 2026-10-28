import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  personalPlanIdSchema,
  personalPlanQuerySchema,
  createPersonalPlanItemSchema,
  updatePersonalPlanItemSchema,
  removePersonalPlanItemSchema,
  personalPlanPageSchema,
  personalPlanSummarySchema,
  personalPlanItemResultSchema,
  personalPlanRemoveResultSchema,
} from "@citygo/contracts";
import { PersonalPlan, DomainError, type Database } from "@citygo/db";

const params = z.strictObject({ id: personalPlanIdSchema });
const emptyQuery = z.strictObject({});
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(400, "Проверьте параметры личного плана");
  return parsed.data;
}
function output<T extends { userId: string }>(
  schema: z.ZodType<T>,
  value: unknown,
  userId: string,
): T {
  const parsed = schema.safeParse(value);
  // Invalid storage/output is not a user validation failure. No raw text or
  // driver details are included in this error or sent back to the browser.
  if (!parsed.success || parsed.data.userId !== userId)
    throw new Error("Invalid personal plan response");
  return parsed.data;
}
async function stored<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error("Invalid stored personal plan data");
    throw error;
  }
}

// Explicit personal actions only. No models, AI policies, legacy questionnaire,
// quests, XP, payments or provider adapters participate in these commands.
export function registerPersonalPlanApi(
  app: FastifyInstance,
  options: {
    db: Database;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
  },
) {
  const plan = new PersonalPlan(options.db);
  const readLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  const writeLimit = { config: { rateLimit: { max: 30, timeWindow: 60_000 } } };
  app.get("/v1/personal-plan", readLimit, async (request) => {
    const user = await options.authenticate(request);
    const query = input(personalPlanQuerySchema, request.query);
    return output(
      personalPlanPageSchema,
      await stored(plan.list(user.id, query.before, query.status)),
      user.id,
    );
  });
  app.get("/v1/personal-plan/summary", readLimit, async (request) => {
    const user = await options.authenticate(request);
    input(emptyQuery, request.query);
    return output(
      personalPlanSummarySchema,
      await stored(plan.summary(user.id)),
      user.id,
    );
  });
  app.post("/v1/personal-plan", writeLimit, async (request) => {
    const user = await options.authenticate(request);
    input(emptyQuery, request.query);
    const command = input(createPersonalPlanItemSchema, request.body);
    const result = output(
      personalPlanItemResultSchema,
      await stored(plan.create(user.id, command)),
      user.id,
    );
    if (result.item.source.messageId !== command.sourceMessageId)
      throw new Error("Invalid personal plan source response");
    return result;
  });
  app.patch("/v1/personal-plan/:id", writeLimit, async (request) => {
    const user = await options.authenticate(request);
    const { id } = input(params, request.params);
    input(emptyQuery, request.query);
    const command = input(updatePersonalPlanItemSchema, request.body);
    const result = output(
      personalPlanItemResultSchema,
      await stored(plan.update(user.id, id, command)),
      user.id,
    );
    if (result.item.id !== id)
      throw new Error("Invalid personal plan item response");
    return result;
  });
  app.delete("/v1/personal-plan/:id", writeLimit, async (request) => {
    const user = await options.authenticate(request);
    const { id } = input(params, request.params);
    input(emptyQuery, request.query);
    const command = input(removePersonalPlanItemSchema, request.body);
    const result = output(
      personalPlanRemoveResultSchema,
      await stored(plan.remove(user.id, id, command.expectedRevision)),
      user.id,
    );
    if (result.itemId !== id)
      throw new Error("Invalid personal plan remove response");
    return result;
  });
}

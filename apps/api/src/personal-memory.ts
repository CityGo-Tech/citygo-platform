import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  personalMemoryIdSchema,
  createPersonalMemoryItemSchema,
  updatePersonalMemoryItemSchema,
  removePersonalMemoryItemSchema,
  personalMemoryListSchema,
  personalMemoryItemResultSchema,
  personalMemoryRemoveResultSchema,
} from "@citygo/contracts";
import { PersonalMemory, DomainError, type Database } from "@citygo/db";

const params = z.strictObject({ id: personalMemoryIdSchema });
const empty = z.strictObject({});
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(400, "Проверьте сведения для памяти разговора");
  return parsed.data;
}
function output<T extends { userId: string }>(
  schema: z.ZodType<T>,
  value: unknown,
  userId: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.userId !== userId)
    throw new Error("Invalid personal memory response");
  return parsed.data;
}
async function stored<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new Error("Invalid stored personal memory data");
    throw error;
  }
}

/** User-confirmed private facts. Saving never invokes a provider or grants AI consent. */
export function registerPersonalMemoryApi(
  app: FastifyInstance,
  options: {
    db: Database;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
  },
) {
  const memory = new PersonalMemory(options.db);
  const readLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  const writeLimit = { config: { rateLimit: { max: 30, timeWindow: 60_000 } } };
  app.get("/v1/personal-memory", readLimit, async (request) => {
    const user = await options.authenticate(request);
    input(empty, request.query);
    return output(
      personalMemoryListSchema,
      await stored(memory.list(user.id)),
      user.id,
    );
  });
  app.post("/v1/personal-memory", writeLimit, async (request) => {
    const user = await options.authenticate(request);
    input(empty, request.query);
    const command = input(createPersonalMemoryItemSchema, request.body);
    const result = output(
      personalMemoryItemResultSchema,
      await stored(memory.create(user.id, command)),
      user.id,
    );
    if (result.item.source.messageId !== command.sourceMessageId)
      throw new Error("Invalid personal memory source response");
    return result;
  });
  app.patch("/v1/personal-memory/:id", writeLimit, async (request) => {
    const user = await options.authenticate(request);
    const { id } = input(params, request.params);
    input(empty, request.query);
    const command = input(updatePersonalMemoryItemSchema, request.body);
    const result = output(
      personalMemoryItemResultSchema,
      await stored(memory.update(user.id, id, command)),
      user.id,
    );
    if (result.item.id !== id)
      throw new Error("Invalid personal memory item response");
    return result;
  });
  app.delete("/v1/personal-memory/:id", writeLimit, async (request) => {
    const user = await options.authenticate(request);
    const { id } = input(params, request.params);
    input(empty, request.query);
    const command = input(removePersonalMemoryItemSchema, request.body);
    const result = output(
      personalMemoryRemoveResultSchema,
      await stored(memory.remove(user.id, id, command.expectedRevision)),
      user.id,
    );
    if (result.itemId !== id)
      throw new Error("Invalid personal memory remove response");
    return result;
  });
}

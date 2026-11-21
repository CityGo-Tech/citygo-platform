import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  confirmHousingChecklistSchema,
  saveHousingChecklistSchema,
  saveHousingPlanSchema,
} from "@citygo/contracts";
import { DomainError, HousingWorkspaceStore, type Database } from "@citygo/db";

import type { MiniAppLaunchProvider } from "./mini-app-launch/verify.js";

const noQuery = z.strictObject({});
const writeLimit = { rateLimit: { max: 30, timeWindow: 60000 } };
const route = "/v1/housing/workspace";
function requireInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new DomainError(400, "Проверьте данные жилищного результата.");
  return result.data;
}

export function registerHousingWorkspaceApi(
  app: FastifyInstance,
  options: {
    db: Database;
    authenticate: (request: FastifyRequest) => Promise<{
      id: string;
      messengerProvider?: MiniAppLaunchProvider | null;
    }>;
    onSaved?: (
      request: FastifyRequest,
      provider: MiniAppLaunchProvider | null | undefined,
    ) => () => Promise<void>;
  },
) {
  const store = new HousingWorkspaceStore(options.db);
  app.get(
    route,
    { config: { rateLimit: { max: 60, timeWindow: 60000 } } },
    async (request) => {
      const owner = await options.authenticate(request);
      requireInput(noQuery, request.query);
      return store.get(owner.id);
    },
  );
  app.put(
    route + "/plan",
    { config: writeLimit, bodyLimit: 8 * 1024 },
    async (request) => {
      const owner = await options.authenticate(request);
      requireInput(noQuery, request.query);
      return store.savePlan(
        owner.id,
        requireInput(saveHousingPlanSchema, request.body),
        options.onSaved?.(request, owner.messengerProvider),
      );
    },
  );
  app.put(
    route + "/checklist",
    { config: writeLimit, bodyLimit: 8 * 1024 },
    async (request) => {
      const owner = await options.authenticate(request);
      requireInput(noQuery, request.query);
      return store.saveChecklist(
        owner.id,
        requireInput(saveHousingChecklistSchema, request.body),
        options.onSaved?.(request, owner.messengerProvider),
      );
    },
  );
  app.put(
    route + "/checklist/confirmation",
    { config: writeLimit, bodyLimit: 8 * 1024 },
    async (request) => {
      const owner = await options.authenticate(request);
      requireInput(noQuery, request.query);
      return store.confirmChecklist(
        owner.id,
        requireInput(confirmHousingChecklistSchema, request.body),
      );
    },
  );
}

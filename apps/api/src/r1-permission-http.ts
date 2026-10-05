import type { FastifyInstance, FastifyRequest } from "fastify";
import { DomainError, type Database } from "@citygo/db";
import { z } from "zod";
import {
  r1SyntheticPermissionReadResponseSchema,
  r1SyntheticPermissionWriteResponseSchema,
  r1SyntheticPermissionRejectionHttpStatus,
  r1SyntheticPermissionLookupResponseSchema,
} from "@citygo/contracts";
import { verifyR1SyntheticPermissionReadiness } from "./r1-permission-access.js";
import { R1SyntheticPermissionStore } from "./r1-permission-store.js";

export type R1SyntheticPermissionHttpOptions = { maxCommandsPerOwner?: number };

// Register only after buildApp's explicit test-only opt-in guard. Not a real
// consent endpoint. No configuration-control routes or public readiness dump.
export function registerR1SyntheticPermissionHttp(
  app: FastifyInstance,
  options: {
    db: Database;
    webOrigin: string;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
    limits: R1SyntheticPermissionHttpOptions;
  },
) {
  const store = new R1SyntheticPermissionStore(options.db, "synthetic_only", {
    verifyReadiness: verifyR1SyntheticPermissionReadiness,
    maxCommandsPerOwner: options.limits.maxCommandsPerOwner ?? 128,
  });
  app.get(
    "/v1/synthetic/permissions/commands/:scope/:requestId",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = await options.authenticate(request);
      if (!z.strictObject({}).safeParse(request.query).success)
        throw new DomainError(400, "Запрос не принимает параметры");
      const parsed = r1SyntheticPermissionLookupResponseSchema.safeParse(
        await store.readCommand(request.params, user.id),
      );
      if (!parsed.success)
        return reply
          .code(503)
          .send({ status: "rejected", code: "STORED_DATA_INVALID" });
      const result = parsed.data;
      return reply
        .code(
          result.status === "synthetic_recorded" ||
            result.status === "not_recorded_at_read"
            ? 200
            : result.status === "unavailable"
              ? 503
              : r1SyntheticPermissionRejectionHttpStatus(result.code),
        )
        .send(result);
    },
  );
  app.get(
    "/v1/synthetic/permissions/current",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const user = await options.authenticate(request);
      if (!z.strictObject({}).safeParse(request.query).success)
        throw new DomainError(400, "Запрос не принимает параметры");
      const parsed = r1SyntheticPermissionReadResponseSchema.safeParse(
        await store.readCurrent(user.id),
      );
      if (!parsed.success)
        return reply
          .code(503)
          .send({ status: "rejected", code: "STORED_DATA_INVALID" });
      const result = parsed.data;
      return reply
        .code(
          result.status === "synthetic_snapshot"
            ? 200
            : result.status === "unavailable"
              ? 503
              : r1SyntheticPermissionRejectionHttpStatus(result.code),
        )
        .send(result);
    },
  );
  app.post(
    "/v1/synthetic/permissions/commands",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      // This is a real test session lookup, not an owner from JSON or a header.
      const user = await options.authenticate(request);
      const bearer = request.headers.authorization?.startsWith("Bearer ");
      if (
        request.headers.origin !== undefined
          ? request.headers.origin !== options.webOrigin
          : !bearer
      )
        throw new DomainError(403, "Недопустимый источник запроса");
      // x-citygo-client:native never exempts COOKIE writes from same-origin.
      const stored = await store.execute(request.body, user.id);
      const parsed = r1SyntheticPermissionWriteResponseSchema.safeParse(
        stored.status === "unconfirmed"
          ? { ...stored, retry: "same_command" }
          : stored,
      );
      // Response validation must not claim a definite rejection of an already
      // committed write. Preserve uncertainty if response construction fails.
      if (!parsed.success)
        return reply.code(503).send({
          status: "unconfirmed",
          code: "STORAGE_UNAVAILABLE",
          retry: "same_command",
        });
      const result = parsed.data;
      if (result.status === "unconfirmed") return reply.code(503).send(result);
      if (result.status === "rejected") {
        const status = r1SyntheticPermissionRejectionHttpStatus(result.code);
        return reply.code(status).send(result);
      }
      return result;
    },
  );
}

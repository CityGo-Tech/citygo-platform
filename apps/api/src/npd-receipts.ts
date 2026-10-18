import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  npdReceiptCommandSchema,
  npdReceiptListQuerySchema,
  adminNpdReceiptListSchema,
  adminNpdReceiptDetailSchema,
  ownerNpdReceiptListSchema,
} from "@citygo/contracts";
import { DomainError, NpdReceipts, type Database } from "@citygo/db";
import { tokenHash } from "./auth.js";

const params = z.strictObject({ id: z.uuid() });
const emptyQuery = z.strictObject({});
// Wire query strings are decoded explicitly; coercing arbitrary arrays,
// booleans or blank strings would accept unintended selectors.
const listQuery = z.strictObject({
  status: npdReceiptListQuerySchema.shape.status,
  after: npdReceiptListQuerySchema.shape.after,
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().max(100))
    .optional(),
});

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(400, "Проверьте поля реестра НПД-чеков");
  return parsed.data;
}

function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  // A corrupt stored record is a server error, never a user validation error.
  if (!parsed.success) throw new Error("Invalid NPD receipt response");
  return parsed.data;
}

// Registry only: no payment creation, refund initiation, tax registration,
// provider credentials, email sender or admin-supplied payment evidence.
export function registerNpdReceipts(
  app: FastifyInstance,
  options: {
    db: Database;
    sessionName: string;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
  },
) {
  const receipts = new NpdReceipts(options.db);
  async function context(request: FastifyRequest) {
    const user = await options.authenticate(request);
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : request.cookies[options.sessionName];
    if (!token) throw new DomainError(401, "Войдите в аккаунт");
    // The store rechecks this exact session, active account, password status
    // and current role inside its security transaction. No stale role ticket.
    return { userId: user.id, sessionTokenHash: tokenHash(token) };
  }
  app.get("/v1/admin/npd/receipts", async (request) => {
    const actor = await context(request);
    const query = input(
      npdReceiptListQuerySchema,
      input(listQuery, request.query),
    );
    return output(
      adminNpdReceiptListSchema,
      await receipts.listAdmin(actor, query),
    );
  });
  app.get("/v1/admin/npd/receipts/:id", async (request) => {
    const actor = await context(request);
    const { id } = input(params, request.params);
    input(emptyQuery, request.query);
    return output(
      adminNpdReceiptDetailSchema,
      await receipts.detailAdmin(actor, id),
    );
  });
  app.post(
    "/v1/admin/npd/receipts/:id/commands",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request) => {
      const actor = await context(request);
      const { id } = input(params, request.params);
      input(emptyQuery, request.query);
      const command = input(npdReceiptCommandSchema, request.body);
      return output(
        adminNpdReceiptDetailSchema,
        await receipts.command(actor, id, command),
      );
    },
  );
  app.get("/v1/payments/receipts", async (request) => {
    const owner = await context(request);
    input(emptyQuery, request.query);
    return output(ownerNpdReceiptListSchema, await receipts.listOwner(owner));
  });
}

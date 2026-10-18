import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { readConfig } from "@citygo/config";
import {
  adminPaymentRefundDetailSchema,
  adminPaymentRefundListSchema,
  adminPaymentSourceListSchema,
  adminPaymentSourceQuerySchema,
  createPaymentRefundSchema,
  ownerPaymentRefundListSchema,
  ownerPaymentSourceListSchema,
  paymentRefundListQuerySchema,
  reconcilePaymentRefundSchema,
  submitPaymentRefundSchema,
} from "@citygo/contracts";
import { DomainError, PaymentRefunds, type Database } from "@citygo/db";
import { tokenHash } from "./auth.js";
import { prepareTestPayments } from "./payments.js";
import {
  YooKassaTestRefundClient,
  YooKassaTestRefundError,
} from "./yookassa-refunds.js";

export type TestRefundClient = Pick<
  YooKassaTestRefundClient,
  "createRefund" | "getRefund"
>;
export function prepareTestRefunds(
  config: ReturnType<typeof readConfig>,
  options: { testing?: boolean; client?: TestRefundClient } = {},
): TestRefundClient | undefined {
  if (
    options.client !== undefined &&
    (config.NODE_ENV !== "test" ||
      options.testing !== true ||
      config.YOOKASSA_MODE !== "test")
  )
    throw new Error(
      "Synthetic refund clients require the isolated test harness",
    );
  if (!prepareTestPayments(config)) return;
  return (
    options.client ??
    new YooKassaTestRefundClient({
      shopId: config.YOOKASSA_SHOP_ID!,
      secretKey: config.YOOKASSA_SECRET_KEY!,
    })
  );
}
const params = z.strictObject({ id: z.uuid() });
const empty = z.strictObject({});
const querySchema = z.strictObject({
  status: paymentRefundListQuerySchema.shape.status,
  after: paymentRefundListQuerySchema.shape.after,
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
    throw new DomainError(400, "Проверьте поля денежного журнала");
  return parsed.data;
}
function output<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid refund response");
  return parsed.data;
}
function failure(error: unknown) {
  if (
    error instanceof YooKassaTestRefundError &&
    error.code === "invalid_input"
  )
    return { reason: "manual_review_required" as const, review: true };
  if (
    error instanceof YooKassaTestRefundError &&
    ["payment_mismatch", "invalid_response"].includes(error.code)
  )
    return { reason: "payment_mismatch" as const, review: true };
  return { reason: "provider_transport_failure" as const, review: false };
}

// The reads expose existing history even with checkout disabled. Monetary HTTP
// commands are sandbox-only: there is intentionally no live refund adapter.
export function registerPaymentRefunds(
  app: FastifyInstance,
  options: {
    db: Database;
    config: ReturnType<typeof readConfig>;
    sessionName: string;
    client?: TestRefundClient;
    authenticate: (request: FastifyRequest) => Promise<{ id: string }>;
  },
) {
  const refunds = new PaymentRefunds(options.db);
  const expected = {
    merchantId: options.config.YOOKASSA_SHOP_ID ?? "",
    test: true,
  };
  const available = () => {
    if (!options.client)
      throw new DomainError(
        503,
        "Сейчас доступен только изолированный тестовый контур возвратов",
      );
    return options.client;
  };
  async function context(request: FastifyRequest) {
    const user = await options.authenticate(request);
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : request.cookies[options.sessionName];
    if (!token) throw new DomainError(401, "Войдите в аккаунт");
    return { userId: user.id, sessionTokenHash: tokenHash(token) };
  }
  app.get("/v1/admin/payments/refunds", async (request) => {
    const actor = await context(request);
    return output(
      adminPaymentRefundListSchema,
      await refunds.listAdmin(actor, input(querySchema, request.query)),
    );
  });
  app.get("/v1/admin/payments/refunds/:id", async (request) => {
    const actor = await context(request),
      { id } = input(params, request.params);
    input(empty, request.query);
    return output(
      adminPaymentRefundDetailSchema,
      await refunds.detailAdmin(actor, id),
    );
  });
  app.get("/v1/admin/payments/sources", async (request) => {
    const actor = await context(request),
      { userId } = input(adminPaymentSourceQuerySchema, request.query);
    return output(
      adminPaymentSourceListSchema,
      await refunds.sources(actor, userId),
    );
  });
  app.get("/v1/payments/sources", async (request) => {
    const owner = await context(request);
    input(empty, request.query);
    return output(ownerPaymentSourceListSchema, await refunds.sources(owner));
  });
  app.get("/v1/payments/refunds", async (request) => {
    const owner = await context(request);
    input(empty, request.query);
    return output(ownerPaymentRefundListSchema, await refunds.listOwner(owner));
  });
  app.post(
    "/v1/admin/payments/refunds",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request) => {
      const actor = await context(request);
      available();
      input(empty, request.query);
      return output(
        adminPaymentRefundDetailSchema,
        await refunds.create(
          actor,
          input(createPaymentRefundSchema, request.body),
          expected,
        ),
      );
    },
  );
  app.post(
    "/v1/admin/payments/refunds/:id/submit",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request) => {
      const actor = await context(request),
        client = available(),
        { id } = input(params, request.params);
      input(empty, request.query);
      input(submitPaymentRefundSchema, request.body);
      const prepared = await refunds.prepareDispatch(actor, id, expected);
      if (!prepared.dispatch)
        return output(adminPaymentRefundDetailSchema, prepared.detail);
      const { token, input: payload } = prepared.dispatch;
      let observation;
      try {
        observation = await client.createRefund(payload);
      } catch (error) {
        const failed = failure(error);
        await refunds.recordDispatchFailure(
          id,
          token,
          failed.reason,
          failed.review,
        );
        return output(
          adminPaymentRefundDetailSchema,
          await refunds.detailAdmin(actor, id),
        );
      }
      await refunds.recordCreate(id, token, observation);
      // Reauthorize the response: a revoked session cannot keep reading PII, but
      // a trusted response above still durably records the in-flight operation.
      return output(
        adminPaymentRefundDetailSchema,
        await refunds.detailAdmin(actor, id),
      );
    },
  );
  app.post(
    "/v1/admin/payments/refunds/:id/reconcile",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request) => {
      const actor = await context(request),
        client = available(),
        { id } = input(params, request.params);
      input(empty, request.query);
      const command = input(reconcilePaymentRefundSchema, request.body);
      const prepared = await refunds.prepareReconcile(
        actor,
        id,
        expected,
        command.candidateProviderRefundId,
      );
      let observation;
      try {
        observation = await client.getRefund(prepared.refundId, prepared.input);
      } catch (error) {
        const failed = failure(error);
        await refunds.recordReconcileFailure(id, failed.reason, failed.review);
        return output(
          adminPaymentRefundDetailSchema,
          await refunds.detailAdmin(actor, id),
        );
      }
      await refunds.recordObservation(id, observation);
      return output(
        adminPaymentRefundDetailSchema,
        await refunds.detailAdmin(actor, id),
      );
    },
  );
}

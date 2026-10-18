import type { FastifyInstance } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createTopupSchema,
  topupOrderSchema,
  type TopupOrder,
} from "@citygo/contracts";
import {
  AiCreditLedger,
  DomainError,
  PaymentTopupOrders,
  type Database,
  type PaymentTopupOrder,
} from "@citygo/db";
import type { readConfig } from "@citygo/config";
import {
  YooKassaTestClient,
  YooKassaTestError,
  type YooKassaTestPayment,
} from "./yookassa.js";

export type TestPaymentClient = Pick<YooKassaTestClient, "create" | "get">;
const REPLAY_LIMIT_MS = 23 * 60 * 60 * 1000;
const paramsSchema = z.strictObject({ orderId: z.uuid() });

// Check injected config before DB initialization as well as readConfig callers.
export function prepareTestPayments(
  config: ReturnType<typeof readConfig>,
  options: { testing?: boolean; client?: TestPaymentClient } = {},
): TestPaymentClient | undefined {
  if (
    options.client !== undefined &&
    (config.NODE_ENV !== "test" ||
      options.testing !== true ||
      config.YOOKASSA_MODE !== "test")
  )
    throw new Error(
      "Synthetic payment clients require the explicit isolated test harness",
    );
  if (config.YOOKASSA_MODE === "disabled") return;
  if (
    config.YOOKASSA_MODE !== "test" ||
    config.NODE_ENV === "production" ||
    config.LLM_PROVIDER !== "disabled" ||
    config.AI_CREDIT_MODE !== "routerai_citygo_10x" ||
    !/^[1-9][0-9]{0,19}$/.test(config.YOOKASSA_SHOP_ID ?? "") ||
    !/^test_[A-Za-z0-9_=-]{8,8192}$/.test(config.YOOKASSA_SECRET_KEY ?? "")
  )
    throw new Error(
      "Test checkout requires isolated non-production settings, disabled AI and test credentials",
    );
  const origin = new URL(config.WEB_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    (origin.port && origin.port !== "443")
  )
    throw new Error("Test checkout requires a fixed HTTPS return origin");
  return (
    options.client ??
    new YooKassaTestClient({
      shopId: config.YOOKASSA_SHOP_ID!,
      secretKey: config.YOOKASSA_SECRET_KEY!,
    })
  );
}

function publicOrder(order: PaymentTopupOrder): TopupOrder {
  return topupOrderSchema.parse({
    orderId: order.id,
    amountKopeks: order.amountKopeks,
    creditMicros: order.amountKopeks * 10_000,
    currency: "RUB",
    test: true,
    status: order.credited
      ? "succeeded"
      : order.status === "queued"
        ? "creating"
        : order.status,
    credited: order.credited,
    ...(order.confirmationUrl
      ? { confirmationUrl: order.confirmationUrl }
      : {}),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  });
}

export function registerPaymentTopups(
  app: FastifyInstance,
  options: {
    db: Database;
    config: ReturnType<typeof readConfig>;
    client?: TestPaymentClient;
    authenticate: (request: {
      headers: { authorization?: string };
      cookies: Record<string, string | undefined>;
    }) => Promise<{ id: string }>;
  },
) {
  const orders = new PaymentTopupOrders(options.db);
  const ledger = new AiCreditLedger(
    options.db,
    "routerai_citygo_10x",
    !!options.client,
  );
  const returnUrl = new URL("/", options.config.WEB_ORIGIN).href;
  function available() {
    if (!options.client)
      throw new DomainError(503, "Пополнение баланса пока недоступно");
    return options.client;
  }
  function configured(order: PaymentTopupOrder) {
    if (
      order.merchantId !== options.config.YOOKASSA_SHOP_ID ||
      order.test !== true ||
      order.returnUrl !== returnUrl
    )
      throw new DomainError(
        409,
        "Для проверки нужна исходная конфигурация тестового магазина",
      );
    const amount = BigInt(order.amountKopeks);
    const payload = {
      amount: {
        value: `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`,
        currency: "RUB",
      },
      capture: true,
      confirmation: { type: "redirect", return_url: returnUrl },
      metadata: { citygo_order_id: order.id },
      description: "Пополнение тестового баланса CityGo",
    };
    if (
      order.createKey !== order.id ||
      !isDeepStrictEqual(order.createPayload, payload)
    )
      throw new DomainError(
        409,
        "Сохранённый запрос платежа требует проверки владельцем",
      );
  }
  function verified(payment: YooKassaTestPayment, order: PaymentTopupOrder) {
    if (
      payment.orderId !== order.id ||
      payment.amountKopeks !== order.amountKopeks ||
      payment.merchantId !== order.merchantId ||
      payment.test !== true ||
      payment.currency !== "RUB" ||
      (order.providerPaymentId && payment.id !== order.providerPaymentId)
    )
      throw new DomainError(
        409,
        "Данные тестового платежа не соответствуют пополнению",
      );
  }
  async function transport<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // No provider bodies, headers, keys, IDs or injected exceptions escape.
      if (error instanceof YooKassaTestError || error instanceof Error)
        throw new DomainError(
          503,
          "Не удалось проверить тестовый платёж. Повторите проверку состояния, не создавайте новый платёж.",
        );
      throw new DomainError(
        503,
        "Тестовый платёж требует повторной проверки состояния",
      );
    }
  }

  app.post(
    "/v1/payments/topups",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request) => {
      const user = await options.authenticate(request);
      const client = available();
      const input = createTopupSchema.parse(request.body);
      const order = await orders.create(
        user.id,
        input.requestId,
        input.amountKopeks,
        options.config.YOOKASSA_SHOP_ID!,
        true,
        returnUrl,
      );
      configured(order);
      if (
        order.providerPaymentId ||
        order.status === "review_required" ||
        order.credited
      )
        return publicOrder(order);
      const age = Date.now() - Date.parse(order.createdAt);
      if (!Number.isFinite(age) || age < -60_000 || age >= REPLAY_LIMIT_MS)
        return publicOrder(await orders.markReviewRequired(user.id, order.id));
      // Persist first. Ambiguous transport outcomes keep the exact same key.
      const payment = await transport(() =>
        client.create({
          orderId: order.id,
          amountKopeks: order.amountKopeks,
          returnUrl: order.returnUrl,
        }),
      );
      verified(payment, order);
      const recorded = await orders.recordProvider(user.id, order.id, {
        providerPaymentId: payment.id,
        // POST success is not settlement proof. Bind first, then require GET.
        status: payment.status === "canceled" ? "canceled" : "pending",
        ...(payment.confirmationUrl
          ? { confirmationUrl: payment.confirmationUrl }
          : {}),
      });
      return publicOrder(recorded);
    },
  );

  app.get("/v1/payments/topups/:orderId", async (request) => {
    const user = await options.authenticate(request);
    available();
    const input = paramsSchema.parse(request.params);
    const order = await orders.get(user.id, input.orderId);
    configured(order);
    return publicOrder(order); // No provider call and no monetary mutation.
  });

  app.post(
    "/v1/payments/topups/:orderId/reconcile",
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request) => {
      const user = await options.authenticate(request);
      const client = available();
      const input = paramsSchema.parse(request.params);
      z.strictObject({}).parse(request.body);
      const order = await orders.get(user.id, input.orderId);
      configured(order);
      if (order.credited || order.status === "canceled")
        return publicOrder(order);
      if (!order.providerPaymentId) {
        const age = Date.now() - Date.parse(order.createdAt);
        if (!Number.isFinite(age) || age < -60_000 || age >= REPLAY_LIMIT_MS)
          return publicOrder(
            await orders.markReviewRequired(user.id, order.id),
          );
        throw new DomainError(
          409,
          "Создание платежа не подтверждено. Повторите исходное создание с прежним ID попытки.",
        );
      }
      const payment = await transport(() =>
        client.get(order.providerPaymentId!, {
          orderId: order.id,
          amountKopeks: order.amountKopeks,
        }),
      );
      verified(payment, order);
      if (payment.status === "succeeded" && payment.paid === true) {
        await ledger.topUpConfirmed(user.id, order.id, {
          providerPaymentId: payment.id,
          paidKopeks: order.amountKopeks,
          merchantId: order.merchantId,
          test: true,
          verifiedAt: payment.verifiedAt,
          verification: "server_get_succeeded",
          currency: "RUB",
        });
      }
      const recorded = await orders.recordProvider(user.id, order.id, {
        providerPaymentId: payment.id,
        status:
          payment.status === "succeeded" && payment.paid === true
            ? "succeeded"
            : payment.status === "canceled"
              ? "canceled"
              : "pending",
        ...(payment.confirmationUrl
          ? { confirmationUrl: payment.confirmationUrl }
          : {}),
      });
      return publicOrder(recorded);
    },
  );
}

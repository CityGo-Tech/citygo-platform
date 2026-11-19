import type { FastifyInstance, FastifyRequest } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createTopupSchema,
  buildYooKassaReceipt,
  YOOKASSA_RECEIPT_PROFILE,
  topupOrderSchema,
  yooKassaReceiptRegistrationSchema,
  type TopupOrder,
} from "@citygo/contracts";
import {
  AiCreditLedger,
  DomainError,
  PaymentTopupOrders,
  assertLiveCheckoutAdmission,
  type Database,
  type PaymentTopupOrder,
} from "@citygo/db";
import { validatePaymentConfig, type readConfig } from "@citygo/config";
import {
  YooKassaClient,
  YooKassaError,
  yooKassaFailureDiagnostic,
  type YooKassaPayment,
} from "./yookassa.js";
import { createPaymentAdmissionBinding } from "./payment-admission.js";

export type PaymentClient = Pick<YooKassaClient, "create" | "get"> &
  Partial<Pick<YooKassaClient, "getReceiptRegistration">>;
type PaymentAuthenticator = (
  request: FastifyRequest,
) => Promise<{ id: string }>;
const REPLAY_LIMIT_MS = 23 * 60 * 60 * 1000;
const paramsSchema = z.strictObject({ orderId: z.uuid() });
const attemptParamsSchema = z.strictObject({ requestId: z.uuid() });

// Check injected config before DB initialization as well as readConfig callers.
export function preparePayments(
  config: ReturnType<typeof readConfig>,
  options: { testing?: boolean; client?: PaymentClient } = {},
): PaymentClient | undefined {
  validatePaymentConfig(config);
  if (
    options.client !== undefined &&
    (config.NODE_ENV !== "test" ||
      options.testing !== true ||
      config.YOOKASSA_MODE === "disabled")
  )
    throw new Error(
      "Synthetic payment clients require the explicit isolated test harness",
    );
  if (config.YOOKASSA_MODE === "disabled") return;
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
    new YooKassaClient({
      mode: config.YOOKASSA_MODE,
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
    test: order.test,
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
    client?: PaymentClient;
    authenticate: PaymentAuthenticator;
    authenticateCreate: PaymentAuthenticator;
    authenticateReconciliation?: PaymentAuthenticator;
    authenticateMaxTest?: PaymentAuthenticator;
    onMaxTestPayment?: () => Promise<void>;
  },
) {
  // Even an injected live test transport gets the same trusted DB admission
  // boundary. There is no option to omit/bypass this binding at the HTTP layer.
  const binding = createPaymentAdmissionBinding(options.config);
  const orders = new PaymentTopupOrders(options.db, binding);
  const ledger = new AiCreditLedger(
    options.db,
    "routerai_citygo_10x",
    !!options.client,
    options.config.AI_CREDIT_RESERVATION_MODE,
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
      order.test !== (options.config.YOOKASSA_MODE === "test") ||
      order.returnUrl !== returnUrl
    )
      throw new DomainError(
        409,
        "Для проверки нужна исходная конфигурация магазина и режима оплаты",
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
      description: order.test
        ? "Пополнение тестового баланса CityGo"
        : "Пополнение баланса CityGo",
      ...(order.payloadVersion === 2
        ? {
            receipt: buildYooKassaReceipt({
              email: order.receiptEmail,
              amountKopeks: order.amountKopeks,
              test: order.test,
            }),
          }
        : {}),
    };
    if (
      order.createKey !== order.id ||
      (order.payloadVersion === 2 &&
        order.receiptProfile !== YOOKASSA_RECEIPT_PROFILE) ||
      !isDeepStrictEqual(order.createPayload, payload)
    )
      throw new DomainError(
        409,
        "Сохранённый запрос платежа требует проверки владельцем",
      );
    return "receipt" in payload ? payload.receipt : undefined;
  }
  function verified(payment: YooKassaPayment, order: PaymentTopupOrder) {
    if (
      payment.orderId !== order.id ||
      payment.amountKopeks !== order.amountKopeks ||
      payment.merchantId !== order.merchantId ||
      payment.test !== order.test ||
      payment.currency !== "RUB" ||
      (order.providerPaymentId && payment.id !== order.providerPaymentId)
    )
      throw new DomainError(409, "Данные платежа не соответствуют пополнению");
  }
  async function transport<T>(
    operation: "create_payment" | "get_payment",
    work: () => Promise<T>,
  ) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const diagnostic = yooKassaFailureDiagnostic(error);
      if (diagnostic) {
        try {
          // Deliberate projection, not an Error serializer or provider body.
          // No identifiers, URLs, description, headers or caller data enter it.
          app.log.warn(
            {
              event: "yookassa_operation_failed",
              operation,
              failureClass: diagnostic.failureClass,
              httpStatus: diagnostic.httpStatus,
              providerCode: diagnostic.providerCode,
              parameter: diagnostic.parameter,
            },
            "YooKassa operation failed",
          );
        } catch {
          // Diagnostics must not change the public or monetary outcome.
        }
      }
      // No provider bodies, headers, keys, IDs or injected exceptions escape.
      if (error instanceof YooKassaError || error instanceof Error)
        throw new DomainError(
          503,
          "Не удалось проверить платёж. Повторите проверку состояния, не создавайте новый платёж.",
        );
      throw new DomainError(503, "Платёж требует повторной проверки состояния");
    }
  }

  async function create(
    request: FastifyRequest,
    authenticate: PaymentAuthenticator,
  ) {
    const user = await authenticate(request);
    const client = available();
    const parsed = createTopupSchema.safeParse(request.body);
    if (!parsed.success)
      throw new DomainError(
        400,
        "Проверьте сумму, ID попытки и email для чека",
      );
    const input = parsed.data;
    const fiscal =
      options.config.YOOKASSA_FISCAL_PROFILE === YOOKASSA_RECEIPT_PROFILE;
    if (options.config.YOOKASSA_MODE === "live" && !fiscal)
      throw new DomainError(
        503,
        "Новый приём платежей требует настроенного чека",
      );
    if ((fiscal && !input.receiptEmail) || (!fiscal && input.receiptEmail))
      throw new DomainError(
        400,
        "Укажите email для чека в настроенном режиме оплаты",
      );
    const order = await orders.create(
      user.id,
      input.requestId,
      input.amountKopeks,
      options.config.YOOKASSA_SHOP_ID!,
      options.config.YOOKASSA_MODE === "test",
      returnUrl,
      fiscal
        ? {
            receiptEmail: input.receiptEmail!,
            receiptProfile: YOOKASSA_RECEIPT_PROFILE,
          }
        : undefined,
    );
    const receipt = configured(order);
    if (
      order.providerPaymentId ||
      order.status === "review_required" ||
      order.credited
    )
      return publicOrder(order);
    if (fiscal && order.payloadVersion !== 2)
      return publicOrder(await orders.markReviewRequired(user.id, order.id));
    const age = Date.now() - Date.parse(order.createdAt);
    if (!Number.isFinite(age) || age < -60_000 || age >= REPLAY_LIMIT_MS)
      return publicOrder(await orders.markReviewRequired(user.id, order.id));
    // Persist first. Ambiguous transport outcomes keep the exact same key.
    // Recheck after durable creation, immediately before the external POST;
    // the provider call itself is never made inside a DB transaction.
    if (binding)
      await options.db.transaction((tx) =>
        assertLiveCheckoutAdmission(tx, binding),
      );
    const payment = await transport("create_payment", () =>
      client.create({
        orderId: order.id,
        amountKopeks: order.amountKopeks,
        returnUrl: order.returnUrl,
        ...(receipt ? { receipt } : {}),
        createPayload: order.createPayload,
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
  }

  async function getAttempt(
    request: FastifyRequest,
    authenticate: PaymentAuthenticator,
  ) {
    const user = await authenticate(request);
    available();
    const input = attemptParamsSchema.parse(request.params);
    const order = await orders.getByRequestId(user.id, input.requestId);
    configured(order);
    return publicOrder(order); // Owner-scoped recovery; no provider call or write.
  }

  async function getOrder(
    request: FastifyRequest,
    authenticate: PaymentAuthenticator,
  ) {
    const user = await authenticate(request);
    available();
    const input = paramsSchema.parse(request.params);
    const order = await orders.get(user.id, input.orderId);
    configured(order);
    return publicOrder(order); // No provider call and no monetary mutation.
  }

  // Trusted server entrypoint reused by authenticated owners and the durable
  // provider inbox. IDs from notifications never act as monetary proof.
  async function reconcileOrder(
    userId: string,
    orderId: string,
    forceGet = false,
    expectedProviderId?: string,
    observe?: {
      payment?: (payment: YooKassaPayment) => void;
      receipt?: (status: YooKassaPayment["receiptRegistration"]) => void;
    },
  ) {
    const client = available();
    const order = await orders.get(userId, orderId);
    configured(order);
    if (
      expectedProviderId !== undefined &&
      order.providerPaymentId !== expectedProviderId
    )
      throw new DomainError(409, "Привязка уведомления к платежу изменилась");
    if (!forceGet && (order.credited || order.status === "canceled"))
      return publicOrder(order);
    if (!order.providerPaymentId) {
      const age = Date.now() - Date.parse(order.createdAt);
      if (!Number.isFinite(age) || age < -60_000 || age >= REPLAY_LIMIT_MS)
        return publicOrder(await orders.markReviewRequired(userId, order.id));
      throw new DomainError(
        409,
        "Создание платежа не подтверждено. Повторите исходное создание с прежним ID попытки.",
      );
    }
    const paymentId = order.providerPaymentId;
    const expected = { orderId: order.id, amountKopeks: order.amountKopeks };
    if (order.credited && observe?.receipt && client.getReceiptRegistration) {
      observe.receipt(
        await transport("get_payment", () =>
          client.getReceiptRegistration!(paymentId, expected),
        ),
      );
      return publicOrder(order);
    }
    const payment = await transport("get_payment", () =>
      client.get(paymentId, expected),
    );
    verified(payment, order);
    observe?.payment?.(payment);
    observe?.receipt?.(payment.receiptRegistration);
    if (payment.status === "succeeded" && payment.paid === true) {
      await ledger.topUpConfirmed(
        userId,
        order.id,
        {
          providerPaymentId: payment.id,
          paidKopeks: order.amountKopeks,
          merchantId: order.merchantId,
          test: order.test,
          verifiedAt: payment.verifiedAt,
          verification: "server_get_succeeded",
          currency: "RUB",
        },
        order.test ? options.onMaxTestPayment : undefined,
      );
    }
    const recorded = await orders.recordProvider(userId, order.id, {
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
  }
  const webPath = "/v1/payments";
  const maxPath = "/v1/mini-apps/max/payments";
  const limits = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };
  const empty = z.strictObject({});
  const scopes = [
    {
      path: webPath,
      read: options.authenticate,
      create: options.authenticateCreate,
      reconcile: options.authenticateReconciliation ?? options.authenticate,
      showProviderReceipt: false,
    },
  ];
  if (options.authenticateMaxTest) {
    const authenticate = options.authenticateMaxTest;
    if (
      options.config.YOOKASSA_MODE !== "test" ||
      !options.client?.getReceiptRegistration
    )
      throw new Error("MAX payment routes require an isolated payment client");
    scopes.push({
      path: maxPath,
      read: authenticate,
      create: authenticate,
      reconcile: authenticate,
      showProviderReceipt: true,
    });
    app.get(maxPath + "/topups", async (request) => {
      const user = await authenticate(request);
      empty.parse(request.query);
      const recent = await orders.listRecentTest(
        user.id,
        options.config.YOOKASSA_SHOP_ID!,
        returnUrl,
      );
      return { orders: recent.map(publicOrder) };
    });
  }
  for (const scope of scopes) {
    app.post(scope.path + "/topups", limits, (request) =>
      create(request, scope.create),
    );
    app.get(scope.path + "/topup-attempts/:requestId", (request) =>
      getAttempt(request, scope.read),
    );
    app.get(scope.path + "/topups/:orderId", (request) =>
      getOrder(request, scope.read),
    );
    app.post(
      scope.path + "/topups/:orderId/reconcile",
      limits,
      async (request) => {
        const user = await scope.reconcile(request);
        const { orderId } = paramsSchema.parse(request.params);
        empty.parse(request.body);
        if (!scope.showProviderReceipt) return reconcileOrder(user.id, orderId);
        let receiptRegistration: YooKassaPayment["receiptRegistration"];
        const order = await reconcileOrder(user.id, orderId, true, undefined, {
          receipt: (status) => {
            receiptRegistration = yooKassaReceiptRegistrationSchema
              .optional()
              .parse(status);
          },
        });
        return receiptRegistration === undefined
          ? order
          : { ...order, receiptRegistration };
      },
    );
  }
  return {
    reconcileOrder,
    async reconcileNotification(
      userId: string,
      orderId: string,
      providerId: string,
    ) {
      let terminal = false;
      await reconcileOrder(userId, orderId, true, providerId, {
        payment: ({ status }) => {
          terminal = status === "succeeded" || status === "canceled";
        },
      });
      return terminal;
    },
  };
}

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  chatInputSchema,
  completionSchema,
  questStartSchema,
  credentialsSchema,
  loginSchema,
  changePasswordSchema,
  changeRoleSchema,
  messageIdSchema,
  setMessageFavoriteSchema,
  favoriteMessagesQuerySchema,
  conversationStartSchema,
  conversationListQuerySchema,
  conversationMessagesQuerySchema,
  conversationHistoryIdSchema,
  conversationIdSchema,
  questionnaireSchema,
  aiConsentSchema,
  aiRoutingInputSchema,
  aiBudgetInputSchema,
  aiCreditGrantSchema,
  aiCreditReconcileSchema,
  CITYGO_10X_TARIFF,
  LEGACY_AT_COST_TARIFF,
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REQUEST_ID_HEADER,
  supportsContractVersion,
  errorMetadata,
  errorCodeForStatus,
  type StreamEvent,
  type ModelGeneration,
  type AiPolicy,
  type HousingStorageLimits,
} from "@citygo/contracts";
import {
  Repository,
  AccountAccess,
  MessageFavorites,
  ensureConversation,
  DomainError,
  AiCreditLedger,
  AiCreditCharges,
  PaymentRefunds,
  PaymentAdmission,
  assertRealAiDatabaseSafety,
  assertTestPaymentsDatabaseSafety,
  type Database,
  HousingStoredDataError,
  verifyHousingReadiness,
} from "@citygo/db";
import {
  readConfig,
  effectiveLlmLimits,
  validateCreditReservationConfig,
  validateVerificationDeliveryConfig,
} from "@citygo/config";
import { instructions, profileContext, routeAgent } from "@citygo/agents";
import { redactPaths } from "@citygo/observability";
import {
  RouterAIInsufficientFundsError,
  type StreamingProvider,
} from "@citygo/llm";
import { hashPassword, verifyPassword, tokenHash, newToken } from "./auth.js";
import { createAiControl } from "./ai-control.js";
import type { ProviderMap } from "./provider.js";
import { createAiExecution } from "./ai-execution.js";
import { ApiDrain, registerDrain } from "./shutdown.js";
import { buildConversationContext } from "./conversation-context.js";
import { registerSyntheticHousingApi } from "./housing.js";
import {
  preparePayments,
  registerPaymentTopups,
  type PaymentClient,
} from "./payments.js";
import { registerNpdReceipts } from "./npd-receipts.js";
import {
  prepareRefunds,
  registerPaymentRefunds,
  type RefundClient,
} from "./payment-refunds.js";
import {
  registerR1SyntheticPermissionHttp,
  type R1SyntheticPermissionHttpOptions,
} from "./r1-permission-http.js";
import {
  PaymentNotificationInbox,
  PAYMENT_NOTIFICATION_PATH,
  registerPaymentNotifications,
} from "./payment-notifications.js";
import {
  createPaymentAdmissionBinding,
  registerPaymentAdmission,
  registerPaymentReconciliation,
} from "./payment-admission.js";
import type { PaymentReconcileScheduler } from "./payment-reconciler.js";
import {
  registerEmailRegistration,
  type RegistrationEmailDelivery,
} from "./email-registration.js";
import {
  configuredEmailDelivery,
  configuredPasswordRecoveryDelivery,
  configuredPhoneDelivery,
} from "./verification-delivery/configured.js";
import {
  registerPasswordRecovery,
  type PasswordRecoveryEmailDelivery,
} from "./password-recovery.js";
import {
  registerPhoneVerification,
  type PhoneVerificationDelivery,
} from "./phone-verification.js";

export async function buildApp(options: {
  db: Database;
  provider?: StreamingProvider;
  providers?: ProviderMap;
  config?: ReturnType<typeof readConfig>;
  testing?: boolean;
  drain?: ApiDrain;
  housingLimits?: Partial<HousingStorageLimits>;
  syntheticPermissions?: R1SyntheticPermissionHttpOptions;
  paymentClient?: PaymentClient;
  refundClient?: RefundClient;
  paymentReconcileScheduler?: PaymentReconcileScheduler;
  emailRegistrationDelivery?: RegistrationEmailDelivery;
  passwordRecoveryDelivery?: PasswordRecoveryEmailDelivery;
  phoneVerificationDelivery?: PhoneVerificationDelivery;
}) {
  const drain = options.drain ?? new ApiDrain();
  const config = options.config ?? readConfig();
  validateCreditReservationConfig(config);
  validateVerificationDeliveryConfig(config);
  if (
    (options.emailRegistrationDelivery ||
      options.passwordRecoveryDelivery ||
      options.phoneVerificationDelivery) &&
    (config.NODE_ENV !== "test" || options.testing !== true)
  )
    throw new Error(
      "Synthetic registration delivery requires the isolated test harness",
    );
  if (
    options.paymentReconcileScheduler &&
    (config.NODE_ENV !== "test" || options.testing !== true)
  )
    throw new Error(
      "Synthetic payment scheduler requires the isolated test harness",
    );
  const paymentClient = preparePayments(config, {
    testing: options.testing,
    client: options.paymentClient,
  });
  const refundClient = prepareRefunds(config, {
    testing: options.testing,
    client: options.refundClient,
  });
  if (
    paymentClient &&
    config.YOOKASSA_MODE === "test" &&
    (options.provider || Object.values(options.providers ?? {}).some(Boolean))
  )
    throw new Error(
      "Test checkout cannot be combined with injected AI providers",
    );
  if (paymentClient) {
    if (config.YOOKASSA_MODE === "test")
      await assertTestPaymentsDatabaseSafety(options.db);
    else await assertRealAiDatabaseSafety(options.db);
  }
  // No environment activation or server/deploy wiring. Even an injected
  // config must have BOTH test mode and the explicit test harness flag.
  if (
    options.syntheticPermissions !== undefined &&
    (config.NODE_ENV !== "test" || options.testing !== true)
  )
    throw new Error(
      "R1 permission HTTP is available only in a synthetic test harness",
    );
  // Also guard explicitly supplied config objects, not just readConfig callers.
  if (
    config.NODE_ENV === "production" &&
    config.R1_HOUSING_API_MODE !== "disabled"
  )
    throw new Error(
      "R1 housing API is synthetic-only; production activation is not implemented",
    );
  const creditCharging = config.AI_CREDIT_MODE !== "disabled";
  const tariff =
    config.AI_CREDIT_MODE === "routerai_citygo_10x"
      ? CITYGO_10X_TARIFF
      : LEGACY_AT_COST_TARIFF;
  const chargingStatus =
    config.AI_CREDIT_MODE === "disabled"
      ? "not_connected"
      : config.AI_CREDIT_MODE;
  const paymentBinding = createPaymentAdmissionBinding(config);
  const paymentAdmission = paymentBinding
    ? new PaymentAdmission(options.db, paymentBinding)
    : undefined;
  const topUpAvailable = async () =>
    !!paymentClient &&
    (config.YOOKASSA_MODE !== "live" ||
      config.YOOKASSA_FISCAL_PROFILE === "citygo_service_full_payment_v1") &&
    (paymentAdmission ? (await paymentAdmission.statusUser()).available : true);
  const repo = new Repository(
    options.db,
    creditCharging,
    tariff,
    topUpAvailable,
    config.AI_CREDIT_RESERVATION_MODE,
  );
  const accounts = new AccountAccess(options.db);
  const credit = new AiCreditLedger(
    options.db,
    chargingStatus,
    topUpAvailable,
    config.AI_CREDIT_RESERVATION_MODE,
  );
  const charges = new AiCreditCharges(
    options.db,
    tariff,
    config.AI_CREDIT_RESERVATION_MODE,
  );
  const providers: ProviderMap = { ...options.providers };
  if (options.provider) providers[options.provider.name] = options.provider;
  // Quarantine survives process restarts and changing YOOKASSA_MODE back to
  // disabled. A per-admission DB guard also protects already running replicas.
  if (
    config.LLM_PROVIDER !== "disabled" ||
    Object.values(providers).some(Boolean)
  )
    await assertRealAiDatabaseSafety(options.db);
  async function reconcileCharge(userId: string, holdId: string) {
    const charge = await charges.get(userId, holdId);
    if (charge.receipt) return credit.status(userId);
    const adapter = providers.routerai;
    if (!charge.response_complete || !charge.generation_id)
      throw new DomainError(
        409,
        "Ответ не подтверждён как завершённый. Нужна ручная сверка с RouterAI; автоматическое освобождение запрещено.",
      );
    if (
      !adapter?.readCharge ||
      adapter.model !== charge.model ||
      config.ROUTERAI_UPSTREAM !== charge.upstream
    )
      throw new DomainError(
        409,
        "Для сверки требуется исходная конфигурация RouterAI.",
      );
    const receipt = await adapter.readCharge(
      charge.generation_id,
      holdId,
      AbortSignal.timeout(5000),
    );
    await charges.settle(userId, holdId, receipt);
    return credit.status(userId);
  }
  const control = createAiControl(config, providers);
  const executions = control.options.flatMap((option) =>
    option.policy ? [createAiExecution(config, option.policy)] : [],
  );
  await repo.initializeAiRouting(
    control.options.find((entry) => entry.provider === options.provider?.name)
      ?.policy ?? null,
  );
  const currentAi = async () => control.resolve(await repo.aiRouting());
  const app = Fastify({
    logger: options.testing ? false : { redact: redactPaths },
    bodyLimit: 16 * 1024,
    genReqId: () => randomUUID(),
    trustProxy: config.TRUSTED_PROXY_CIDRS.length
      ? config.TRUSTED_PROXY_CIDRS
      : false,
  });
  const secure = config.NODE_ENV === "production";
  registerDrain(app, drain);
  const sessionName = secure ? "__Host-citygo" : "citygo";
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    maxAge: 7 * 86400,
  };
  await app.register(cookie);
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    exposedHeaders: [CONTRACT_VERSION_HEADER, REQUEST_ID_HEADER],
  });
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header(CONTRACT_VERSION_HEADER, CONTRACT_VERSION)
      .header(REQUEST_ID_HEADER, request.id)
      .header("Cache-Control", "no-store");
    // CORS preflight has no version value. Health/readiness are not v1 resources.
    if (request.method === "OPTIONS" || !request.url.startsWith("/v1/")) return;
    if (
      !supportsContractVersion(
        request.headers[CONTRACT_VERSION_HEADER.toLowerCase()],
      )
    )
      throw new DomainError(
        400,
        "Версия приложения не поддерживается. Обновите приложение перед продолжением.",
        "CONTRACT_VERSION_UNSUPPORTED",
      );
  });
  // The limiter installs an onRoute hook: register it before declaring routes.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });
  const dummyHash = hashPassword(randomUUID());
  const bearer = (authorization?: string) =>
    authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  async function authenticate(
    request: {
      headers: { authorization?: string };
      cookies: Record<string, string | undefined>;
    },
    allowPasswordChange = false,
  ) {
    const token =
      bearer(request.headers.authorization) ?? request.cookies[sessionName];
    const user = token ? await repo.session(tokenHash(token)) : undefined;
    if (!user) throw new DomainError(401, "Войдите в аккаунт");
    const account = await accounts.info(user.id);
    if (!account) throw new DomainError(401, "Войдите в аккаунт");
    if (account.mustChangePassword && !allowPasswordChange)
      throw new DomainError(
        403,
        "Сначала измените временный пароль в личном кабинете",
      );
    return account;
  }
  async function authenticateAdmin(
    request: Parameters<typeof authenticate>[0],
  ) {
    const user = await authenticate(request);
    if (user.role !== "admin" && user.role !== "super_admin")
      throw new DomainError(403, "Доступ только для администратора");
    return user;
  }
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    // One exact machine-only webhook. It cannot authenticate browser writes;
    // the handler rejects Cookie/Origin/Authorization and only queues ID hints.
    if (
      config.YOOKASSA_MODE === "live" &&
      paymentClient &&
      request.method === "POST" &&
      request.url === PAYMENT_NOTIFICATION_PATH &&
      request.headers.origin === undefined &&
      request.headers.cookie === undefined &&
      request.headers.authorization === undefined
    )
      return;
    // Cookie-authenticated writes must be same-origin. Native clients use bearer sessions.
    if (
      request.headers.origin
        ? request.headers.origin !== config.WEB_ORIGIN
        : !bearer(request.headers.authorization) &&
          request.headers["x-citygo-client"] !== "native"
    ) {
      throw new DomainError(403, "Недопустимый источник запроса");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HousingStoredDataError) {
      request.log.error(
        {
          code: "HOUSING_DATA_ERROR",
          reason: error.reason,
          ...error.context,
          requestId: request.id,
        },
        "Housing data failed",
      );
      return reply.code(500).send({
        ...errorMetadata("INTERNAL_ERROR", request.id),
        error: "Не удалось выполнить запрос",
      });
    }
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        ...errorMetadata("VALIDATION_ERROR", request.id),
        error: "Проверьте поля формы",
        fields: error.flatten().fieldErrors,
      });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({
        ...errorMetadata(error.code, request.id, error.currentVersion),
        error: error.message,
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply.code(429).send({
        ...errorMetadata("RATE_LIMITED", request.id),
        error: "Слишком много запросов. Попробуйте позже.",
      });
    if ((error as { code?: string }).code === "23505")
      return reply.code(409).send({
        ...errorMetadata("CONFLICT", request.id),
        error: "Запись уже существует",
      });
    request.log.error(
      { code: (error as { code?: string }).code, requestId: request.id },
      "Request failed",
    );
    return reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .send({
        ...errorMetadata(errorCodeForStatus(status ?? 500), request.id),
        error: "Не удалось выполнить запрос",
      });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      ...errorMetadata("NOT_FOUND", request.id),
      error: "Ресурс не найден",
    }),
  );
  app.get("/health", async () => ({
    service: "citygo-api",
    status: "ok",
    timestamp: new Date().toISOString(),
  }));
  app.get("/ready", async () => {
    try {
      const result = await options.db.query(
        "select name from citygo_migrations where name in ('0006_ai_budget.sql','0007_ai_user_daily_budget.sql','0008_ai_credit.sql','0009_ai_credit_charges.sql','0010_quest_plan_expand.sql','0011_quest_plan_validate.sql','0013_account_access.sql','0014_citygo_credit.sql','0015_yookassa_orders.sql','0016_npd_receipts.sql','0017_credit_source_lots.sql','0018_payment_refunds.sql','0019_yookassa_live_orders.sql','0020_ai_budget_provider_balance.sql','0021_payment_notifications.sql','0022_payment_admission.sql','0023_payment_receipt_snapshots.sql','0024_ai_credit_overdraft.sql','0025_assistant_conversations.sql')",
      );
      if (result.rows.length !== 19) throw new Error("Pending migration");
      if (config.EMAIL_REGISTRATION_MODE === "required") {
        const verification = await options.db.query(
          "select name from citygo_migrations where name='0026_email_registration.sql'",
        );
        if (verification.rows.length !== 1)
          throw new Error("Pending verification migration");
        await options.db.query(
          "select id,delivery,attempts from email_registrations limit 0",
        );
        await options.db.query(
          "select key_hash from email_registration_rate_events limit 0",
        );
        await options.db.query(
          "select user_id from account_email_verifications limit 0",
        );
        const recovery = await options.db.query(
          "select name from citygo_migrations where name='0028_password_recovery.sql'",
        );
        if (recovery.rows.length !== 1)
          throw new Error("Pending password recovery migration");
        await options.db.query(
          "select id,delivery,attempts from password_recovery_challenges limit 0",
        );
      }
      if (config.PHONE_VERIFICATION_MODE !== "disabled") {
        const phone = await options.db.query(
          "select name from citygo_migrations where name='0027_phone_verification.sql'",
        );
        if (phone.rows.length !== 1) throw new Error("Pending phone migration");
        for (const table of [
          "phone_verification_control",
          "phone_verification_challenges",
          "phone_verification_sends",
          "phone_welcome_claims",
        ])
          await options.db.query(`select 1 from ${table} limit 0`);
      }
      if (config.R1_HOUSING_API_MODE === "synthetic")
        await verifyHousingReadiness(options.db);
    } catch {
      throw new DomainError(503, "База данных не готова: примените миграции");
    }
    return { status: "ok" };
  });
  if (config.R1_HOUSING_API_MODE === "synthetic")
    registerSyntheticHousingApi(app, {
      db: options.db,
      authenticate,
      limits: options.housingLimits,
    });
  if (options.syntheticPermissions !== undefined)
    registerR1SyntheticPermissionHttp(app, {
      db: options.db,
      webOrigin: config.WEB_ORIGIN,
      authenticate,
      limits: options.syntheticPermissions,
    });
  const topups = registerPaymentTopups(app, {
    db: options.db,
    config,
    client: paymentClient,
    authenticate,
  });
  registerPaymentAdmission(app, {
    admission: paymentAdmission,
    sessionName,
    authenticate,
    topUpAvailable,
  });
  registerNpdReceipts(app, {
    db: options.db,
    sessionName,
    authenticate,
  });
  registerPaymentRefunds(app, {
    db: options.db,
    config,
    sessionName,
    client: refundClient,
    authenticate,
  });
  if (paymentClient && refundClient && config.YOOKASSA_MODE === "live") {
    const refundJournal = new PaymentRefunds(options.db);
    const inbox = new PaymentNotificationInbox(options.db, {
      mode: "live",
      merchantId: config.YOOKASSA_SHOP_ID!,
      reconcile: async (item) => {
        if (item.kind === "payment") {
          return (await topups.reconcileNotification(
            item.userId,
            item.localId,
            item.objectId,
          ))
            ? "verified"
            : "retry";
        }
        const saved = await refundJournal.prepareServerReconcile(item.localId, {
          merchantId: item.merchantId,
          test: item.test,
        });
        if (saved.refundId !== item.objectId)
          throw new Error("Notification binding changed");
        const observed = await refundClient.getRefund(
          saved.refundId,
          saved.input,
        );
        const result = await refundJournal.recordObservation(
          item.localId,
          observed,
        );
        return ["succeeded", "canceled"].includes(observed.status) &&
          ["succeeded", "canceled"].includes(result.refund.status) &&
          !result.refund.reviewReason
          ? "verified"
          : "retry";
      },
    });
    registerPaymentNotifications(app, inbox);
    registerPaymentReconciliation(app, {
      admission: paymentAdmission!,
      inbox,
      drain,
      testing: options.testing === true,
      scheduler: options.paymentReconcileScheduler,
    });
    // This bounded manual settlement drain remains usable when checkout or
    // background reconciliation is closed. The separate API lifecycle above
    // requires its explicit shared DB flag/lease, never Worker DB privileges.
    app.post(
      "/v1/admin/payments/notifications/reconcile",
      {
        config: { rateLimit: { max: 5, timeWindow: 60_000 } },
      },
      async (request) => {
        await authenticateAdmin(request);
        const command = z
          .strictObject({ limit: z.number().int().min(1).max(25).default(10) })
          .parse(request.body);
        return inbox.processPending(command.limit);
      },
    );
  }
  registerEmailRegistration(app, {
    db: options.db,
    mode: config.EMAIL_REGISTRATION_MODE,
    secret: config.EMAIL_REGISTRATION_SECRET,
    delivery:
      options.emailRegistrationDelivery ?? configuredEmailDelivery(config),
    sendLimits:
      config.EMAIL_DELIVERY_PROVIDER === "yandex_postbox"
        ? {
            daily:
              config.EMAIL_SEND_DAILY_LIMIT === "unlimited"
                ? null
                : config.EMAIL_SEND_DAILY_LIMIT,
            total:
              config.EMAIL_SEND_TOTAL_LIMIT === "unlimited"
                ? null
                : config.EMAIL_SEND_TOTAL_LIMIT,
          }
        : undefined,
    setSession: (reply, token) => {
      reply.setCookie(sessionName, token, cookieOptions);
    },
  });
  registerPasswordRecovery(app, {
    db: options.db,
    mode: config.EMAIL_REGISTRATION_MODE,
    secret: config.EMAIL_REGISTRATION_SECRET,
    delivery:
      options.passwordRecoveryDelivery ??
      configuredPasswordRecoveryDelivery(config),
    sendLimits:
      config.EMAIL_DELIVERY_PROVIDER === "yandex_postbox"
        ? {
            daily:
              config.EMAIL_SEND_DAILY_LIMIT === "unlimited"
                ? null
                : config.EMAIL_SEND_DAILY_LIMIT,
            total:
              config.EMAIL_SEND_TOTAL_LIMIT === "unlimited"
                ? null
                : config.EMAIL_SEND_TOTAL_LIMIT,
          }
        : undefined,
  });
  registerPhoneVerification(app, {
    db: options.db,
    config,
    delivery:
      options.phoneVerificationDelivery ?? configuredPhoneDelivery(config),
    context: async (request) => {
      const user = await authenticate(request);
      const token =
        bearer(request.headers.authorization) ?? request.cookies[sessionName];
      return { userId: user.id, sessionTokenHash: tokenHash(token!) };
    },
  });
  for (const action of ["register", "login"] as const) {
    app.post(
      "/v1/auth/" + action,
      {
        config: {
          rateLimit: {
            max: 10,
            timeWindow: "15 minutes",
          },
        },
      },
      async (request, reply) => {
        const input = (
          action === "register" ? credentialsSchema : loginSchema
        ).parse(request.body);
        let id: string;
        let expectedHash: string;
        if (action === "register") {
          if (config.EMAIL_REGISTRATION_MODE === "required")
            throw new DomainError(
              503,
              "Для регистрации необходимо подтверждение почты. Начните регистрацию заново.",
            );
          expectedHash = await hashPassword(input.password);
          id = await repo.register(input.email, expectedHash);
        } else {
          const candidate = await accounts.credentials(input.email);
          const valid = await verifyPassword(
            input.password,
            candidate?.password_hash ?? (await dummyHash),
          );
          if (!candidate || !valid)
            throw new DomainError(401, "Неверный логин или пароль");
          id = candidate.id;
          expectedHash = candidate.password_hash;
        }
        const token = newToken();
        // Recheck the verified hash under the same lock as password rotation.
        // A pending login with an old password cannot mint a fresh session.
        const user = await accounts.createVerifiedSession(
          id,
          expectedHash,
          tokenHash(token),
        );
        reply.setCookie(sessionName, token, cookieOptions);
        // Native mode is explicit; browser sessions remain HttpOnly.
        return {
          user,
          ...(request.headers["x-citygo-client"] === "native" ? { token } : {}),
        };
      },
    );
  }
  app.post(
    "/v1/auth/password",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const user = await authenticate(request, true);
      const input = changePasswordSchema.parse(request.body);
      const current = await accounts.credentials(user.email);
      if (
        !current ||
        !(await verifyPassword(input.currentPassword, current.password_hash))
      )
        throw new DomainError(401, "Текущий пароль неверен");
      if (input.password === input.currentPassword)
        throw new DomainError(
          400,
          "Новый пароль должен отличаться от временного или текущего",
        );
      const token = newToken();
      const account = await accounts.changePassword(
        user.id,
        current.password_hash,
        await hashPassword(input.password),
        tokenHash(token),
      );
      reply.setCookie(sessionName, token, cookieOptions);
      return {
        user: account,
        ...(request.headers["x-citygo-client"] === "native" ? { token } : {}),
      };
    },
  );
  app.get("/v1/admin/accounts", async (request) => {
    const actor = await authenticateAdmin(request);
    return { users: await accounts.list(actor.id) };
  });
  app.post("/v1/admin/accounts/role", async (request) => {
    const actor = await authenticateAdmin(request);
    const input = changeRoleSchema.parse(request.body);
    return { user: await accounts.setRole(actor.id, input.userId, input.role) };
  });
  app.post("/v1/conversations/start", async (request) => {
    const user = await authenticate(request);
    const input = conversationStartSchema.parse(request.body ?? {});
    return ensureConversation(options.db, user.id, input.agentKey);
  });
  app.get("/v1/conversations", async (request) => {
    const user = await authenticate(request);
    const query = conversationListQuerySchema.parse(request.query);
    return repo.conversations(user.id, query.before);
  });
  app.get("/v1/conversations/:id/messages", async (request) => {
    const user = await authenticate(request);
    const id = conversationHistoryIdSchema.parse(
      (request.params as { id: string }).id,
    );
    const query = conversationMessagesQuerySchema.parse(request.query);
    return repo.conversationMessages(user.id, id, query.before);
  });
  app.get("/v1/conversations/:id", async (request) => {
    const user = await authenticate(request);
    const id = conversationIdSchema.parse(
      (request.params as { id: string }).id,
    );
    return repo.conversation(user.id, id);
  });
  const favorites = new MessageFavorites(options.db);
  app.get("/v1/messages/favorites", async (request) => {
    const user = await authenticate(request);
    const query = favoriteMessagesQuerySchema.parse(request.query);
    return favorites.list(user.id, query.before);
  });
  app.post("/v1/messages/:id/favorite", async (request) => {
    const user = await authenticate(request);
    const id = messageIdSchema.parse((request.params as { id: string }).id);
    const input = setMessageFavoriteSchema.parse(request.body);
    return favorites.set(user.id, id, input.saved);
  });
  app.post("/v1/auth/logout", async (request, reply) => {
    const token =
      bearer(request.headers.authorization) ?? request.cookies[sessionName];
    if (token) await repo.logout(tokenHash(token));
    reply.clearCookie(sessionName, {
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "lax",
    });
    return { ok: true };
  });
  app.get("/v1/dashboard", async (request) => {
    const user = await authenticate(request, true);
    const active = await currentAi();
    return repo.dashboard(
      user,
      active.provider?.name ?? "unconfigured",
      active.policy,
      config.LLM_USER_DAILY_REQUEST_LIMIT,
    );
  });
  app.post("/v1/ai/consent", async (request) => {
    const user = await authenticate(request);
    const input = aiConsentSchema.parse(request.body);
    if (input.action === "revoked") {
      await repo.aiConsent(user.id, null);
      return { ok: true };
    }
    const active = await currentAi();
    if (!active.policy || input.policyId !== active.policy.id)
      throw new DomainError(
        409,
        "AI-получатель изменился. Обновите страницу и проверьте условия.",
        "AI_POLICY_CHANGED",
      );
    await repo.aiConsent(user.id, {
      policy: active.policy,
      revision: active.current.revision,
    });
    return { ok: true };
  });
  app.post("/v1/questionnaire", async (request) => {
    const user = await authenticate(request);
    await repo.questionnaire(user.id, questionnaireSchema.parse(request.body));
    return { ok: true };
  });
  const questParams = z.object({ id: z.string().regex(/^[1-9]\d*$/) });
  app.post("/v1/quests/:id/start", async (request) => {
    const user = await authenticate(request);
    const input = questStartSchema.parse(request.body ?? {});
    return repo.start(
      user.id,
      questParams.parse(request.params).id,
      input.plan,
    );
  });
  app.post("/v1/quests/:id/complete", async (request) => {
    const user = await authenticate(request);
    const input = completionSchema.parse(request.body);
    return repo.complete(
      user.id,
      questParams.parse(request.params).id,
      input.plan,
    );
  });
  app.post(
    "/v1/threads/:id/messages",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const user = await authenticate(request);
      const threadId = questParams.parse(request.params).id;
      const input = chatInputSchema.parse(request.body);
      if (
        config.AI_CREDIT_RESERVATION_MODE === "fixed5_overdraft" &&
        input.creditReservationMode !== "fixed5_overdraft" &&
        !routeAgent(input.text, "support").human
      )
        throw new DomainError(
          409,
          "Условия списания изменились: резерв 5 ₽ CityGo не является итоговой ценой, возможен отрицательный остаток. Обновите приложение перед платным запросом.",
        );
      // Immutable snapshot for this admission. A concurrent switch is caught by
      // the repository lock/revision check before any message or quota is stored.
      const { provider, policy: aiPolicy, current } = await currentAi();
      if (!provider || !aiPolicy)
        throw new DomainError(
          503,
          "AI пока недоступен. Администратору нужно проверить выбранного провайдера и настройки сервера.",
          "AI_UNAVAILABLE",
        );
      if (input.policyId !== aiPolicy.id)
        throw new DomainError(
          409,
          "AI-получатель изменился или не подтверждён. Обновите страницу и проверьте условия.",
          "AI_POLICY_CHANGED",
        );
      if (
        creditCharging &&
        (provider.name !== "routerai" ||
          !provider.readCharge ||
          !config.ROUTERAI_UPSTREAM)
      )
        throw new DomainError(
          503,
          "Для этого провайдера списание с баланса не подключено.",
          "AI_CREDIT_UNAVAILABLE",
        );
      const limits = effectiveLlmLimits(config, provider.name, provider.model);
      const reservation = await repo.reserveChat(
        user.id,
        threadId,
        input.requestId,
        input.text,
        {
          policyId: aiPolicy.id,
          revision: current.revision,
          userDailyLimit: config.LLM_USER_DAILY_REQUEST_LIMIT,
          globalDailyLimit: config.LLM_GLOBAL_DAILY_REQUEST_LIMIT,
          leaseMs: limits.chatLeaseMs,
        },
      );
      const routing = routeAgent(input.text, reservation.thread.agent_key);
      // A chosen assistant is a conversation boundary, not a keyword hint.
      // Keep the established human-escalation path; legacy unpinned threads
      // retain their existing automatic specialist routing.
      if (!routing.human && reservation.thread.conversation_agent_key) {
        routing.to = reservation.thread.conversation_agent_key;
        routing.reason = "Пользователь выбрал этого помощника";
      }
      const abort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        drain.signal,
        AbortSignal.timeout(limits.requestTimeoutMs),
      ]);
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      const send = (event: StreamEvent) => {
        if (!reply.raw.destroyed)
          reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
      };
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) abort.abort();
      });
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n");
      }, 15000);
      let content = "";
      let saved = false;
      let generation: ModelGeneration | undefined;
      let attemptNumber = 0;
      let attemptError: DomainError | undefined;
      let creditHoldId: string | null = null;
      let adapterEntered = false;
      const reserveAttempt = async () => {
        signal.throwIfAborted();
        try {
          if (attemptNumber > 0 && content.length > 0)
            throw new DomainError(409, "Повтор после начала ответа запрещён.");
          creditHoldId = await repo.reserveAiAttempt({
            userId: user.id,
            threadId,
            requestId: input.requestId,
            lease: reservation.lease,
            attemptNumber: ++attemptNumber,
            provider: provider.name,
            model: provider.model,
            policyId: aiPolicy.id,
            routingRevision: current.revision,
            userDailyLimit: config.LLM_USER_DAILY_ATTEMPT_LIMIT,
            globalDailyLimit: config.LLM_GLOBAL_DAILY_ATTEMPT_LIMIT,
            execution: createAiExecution(config, aiPolicy),
            upstream: config.ROUTERAI_UPSTREAM,
          });
        } catch (error) {
          if (error instanceof DomainError) attemptError = error;
          abort.abort();
          throw error;
        }
        signal.throwIfAborted();
      };
      try {
        if (routing.to !== reservation.thread.agent_key || routing.human) {
          await repo.handoff(
            user.id,
            threadId,
            reservation.thread.agent_key,
            routing.to,
            routing.reason,
            routing.human,
          );
          send({
            type: "handoff",
            from: reservation.thread.agent_key,
            to: routing.to,
            reason: routing.reason,
          });
        }
        if (routing.human) {
          content =
            "Запрос на помощь человека сохранён. Живой риелтор пока не подключён к CityGo; это не отправка сообщения внешнему специалисту. Не переводите деньги и не отправляйте документы до независимой проверки.";
          send({ type: "delta", text: content });
        } else {
          let modelContext: ReturnType<typeof buildConversationContext>;
          try {
            modelContext = buildConversationContext({
              instructions: instructions(routing.to),
              profile: profileContext(reservation.profile),
              history: reservation.messages,
              currentQuestion: input.text,
              maxInputBytes: config.LLM_MAX_INPUT_BYTES,
            });
          } catch (error) {
            if (error instanceof DomainError) attemptError = error;
            throw error;
          }
          const { instructions: modelInstructions, messages: modelMessages } =
            modelContext;
          // Bound context and reserve both attempt + money before adapter/OAuth.
          // No automatic refund: even a failed request may have been billed.
          await reserveAttempt();
          generation = {
            provider: provider.name,
            requestedModel: provider.model,
          };
          let completed = false;
          if (creditHoldId) await charges.dispatch(user.id, creditHoldId);
          signal.throwIfAborted();
          adapterEntered = true;
          for await (const event of provider.stream(
            modelInstructions,
            modelMessages,
            signal,
            {
              beforeRetry: reserveAttempt,
              ...(creditHoldId
                ? {
                    billing: {
                      reference: creditHoldId,
                      onGeneration: (id: string) =>
                        charges.identify(user.id, creditHoldId!, id),
                    },
                  }
                : {}),
            },
          )) {
            signal.throwIfAborted();
            if (completed)
              throw new Error("Provider sent events after completion");
            if (event.type === "complete") {
              if (!event.model.trim())
                throw new Error("Provider omitted model");
              completed = true;
              generation = {
                ...generation,
                model: event.model,
                ...(event.usage ? { usage: event.usage } : {}),
              };
            } else {
              content += event.text;
              if (content.length > limits.maxOutputCharacters)
                throw new Error("Response too large");
              send({ type: "delta", text: event.text });
            }
          }
          signal.throwIfAborted();
          if (!completed) throw new Error("Provider stream interrupted");
          if (!content.trim()) throw new Error("Empty response");
        }
        const messageId = await repo.finishChat(
          threadId,
          input.requestId,
          reservation.lease,
          routing.to,
          content,
          true,
          !routing.human,
          generation,
          creditHoldId ?? undefined,
        );
        saved = true;
        if (creditHoldId) {
          // Read-only cost lookup, not a second model attempt. A lost/invalid
          // receipt leaves a durable hold for reconciliation, never a guessed fee.
          await reconcileCharge(user.id, creditHoldId).catch(() => {});
        }
        send({ type: "done", messageId });
      } catch (error) {
        if (error instanceof RouterAIInsufficientFundsError)
          attemptError = new DomainError(
            503,
            "AI временно недоступен: баланс внешнего сервиса исчерпан или недостаточен для запроса. Администратору нужно пополнить его. Повтор автоматически не выполняется; существующий резерв требует сверки.",
            "AI_CREDIT_UNAVAILABLE",
          );
        if (creditHoldId && !adapterEntered)
          await charges
            .releaseBeforeTransport(user.id, creditHoldId)
            .catch(() => {});
        const creditRefusedBeforeDispatch =
          attemptError?.code === "AI_CREDIT_EXHAUSTED" &&
          !adapterEntered &&
          !creditHoldId &&
          !generation &&
          content.length === 0 &&
          !routing.human;
        const persistedContent = creditRefusedBeforeDispatch
          ? "Недостаточно средств на балансе CityGo для отправки запроса ИИ. Пополните баланс, чтобы продолжить. Запрос не отправлен ИИ, деньги не списаны."
          : content;
        let persistenceFailed = false;
        if (!saved)
          await repo
            .finishChat(
              threadId,
              input.requestId,
              reservation.lease,
              routing.to,
              persistedContent,
              false,
              creditRefusedBeforeDispatch ? false : !routing.human,
              generation,
              undefined,
              creditRefusedBeforeDispatch ? "AI_CREDIT_EXHAUSTED" : undefined,
            )
            .catch(() => {
              persistenceFailed = true;
              drain.markSettlementFailed();
              request.log.error("Failed to persist interrupted response");
            });
        send({
          type: "error",
          ...errorMetadata(
            attemptError?.code ?? "STREAM_INTERRUPTED",
            request.id,
            attemptError?.currentVersion,
          ),
          message: persistenceFailed
            ? "Ответ прерван. Не удалось подтвердить сохранение истории. Обновите историю и обратитесь к администратору перед повторной отправкой."
            : (attemptError?.message ??
              (creditHoldId
                ? "Ответ прерван. История сохранена. Стоимость уточняется; резерв удерживается до сверки. Не повторяйте запрос вслепую."
                : "Ответ прерван. История сохранена; попробуйте отправить сообщение снова.")),
        });
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    },
  );
  app.get("/v1/admin/ai", async (request) => {
    await authenticateAdmin(request);
    const active = await currentAi();
    return {
      current: active.current,
      effectiveProvider: active.provider?.name ?? "unconfigured",
      environmentDisabled: control.environmentDisabled,
      automaticFallback: false,
      options: control.options,
      audit: await repo.aiRoutingAudit(),
      budget: await repo.aiBudget(executions),
      attempts: await repo.aiAttemptOverview(
        config.LLM_USER_DAILY_ATTEMPT_LIMIT,
        config.LLM_GLOBAL_DAILY_ATTEMPT_LIMIT,
      ),
    };
  });
  app.get("/v1/ai/credit", async (request) => {
    const user = await authenticate(request);
    return credit.status(user.id);
  });
  app.post("/v1/admin/ai/credit/reconcile", async (request) => {
    await authenticateAdmin(request);
    const input = aiCreditReconcileSchema.parse(request.body);
    return reconcileCharge(input.userId, input.holdId);
  });
  app.post("/v1/admin/ai/credit/welcome", async (request) => {
    const actor = await authenticateAdmin(request);
    if (config.AI_CREDIT_MODE === "routerai_citygo_10x")
      throw new DomainError(
        503,
        "Подарок доступен только после подтверждения телефона. Сервис подтверждения ещё не подключён.",
      );
    const input = aiCreditGrantSchema.parse(request.body);
    return credit.grantWelcome(input.userId, actor.id);
  });
  app.post("/v1/admin/ai", async (request) => {
    const user = await authenticateAdmin(request);
    const input = aiRoutingInputSchema.parse(request.body);
    let policy: AiPolicy | null = null;
    if (input.provider !== "disabled") {
      const option = control.options.find(
        (entry) => entry.provider === input.provider,
      );
      if (!option?.policy || option.policy.id !== input.policyId)
        throw new DomainError(
          409,
          "Провайдер недоступен или его настройки изменились. Обновите список.",
          "AI_POLICY_CHANGED",
        );
      policy = option.policy;
    }
    return repo.changeAiRouting(user.id, input, policy);
  });
  app.post("/v1/admin/ai/budget", async (request) => {
    const user = await authenticateAdmin(request);
    return repo.changeAiBudget(
      user.id,
      aiBudgetInputSchema.parse(request.body),
      executions,
    );
  });
  app.get("/v1/admin/overview", async (request) => {
    await authenticateAdmin(request);
    const counts = (
      await options.db.query<{ users: number; completed: number; xp: number }>(
        "select (select count(*)::integer from users) as users,(select count(*)::integer from user_quests where state='completed') as completed,(select coalesce(sum(points),0)::integer from xp_events) as xp",
      )
    ).rows[0];
    const pendingHuman = (
      await options.db.query(
        "select id::text,thread_id::text,reason,created_at from agent_handoffs where requires_human=true order by id desc limit 50",
      )
    ).rows;
    return { counts, pendingHuman };
  });
  return app;
}

import {
  accountUserResponseSchema,
  adminOverviewResponseSchema,
  adminUsersResponseSchema,
  aiBudgetSettingsSchema,
  aiCreditResponseSchema,
  createTopupSchema,
  topupOrderSchema,
  aiControlResponseSchema,
  aiRoutingResponseSchema,
  apiErrorResponseSchema,
  authResponseSchema,
  nativeAuthResponseSchema,
  registrationWithConsentsSchema,
  registrationPolicyResponseSchema,
  serviceConsentChoiceSchema,
  serviceConsentPolicySchema,
  serviceConsentStateSchema,
  emailRegistrationChallengeSchema,
  emailRegistrationResendSchema,
  emailRegistrationConfirmSchema,
  passwordRecoveryPolicySchema,
  passwordRecoveryRequestSchema,
  passwordRecoveryChallengeSchema,
  passwordRecoveryResendSchema,
  passwordRecoveryConfirmSchema,
  passwordRecoveryReceiptSchema,
  phoneVerificationPolicySchema,
  phoneVerificationStartSchema,
  phoneVerificationResendSchema,
  phoneVerificationConfirmSchema,
  phoneVerificationChallengeSchema,
  phoneVerificationReceiptSchema,
  adminNpdReceiptListSchema,
  adminNpdReceiptDetailSchema,
  ownerNpdReceiptListSchema,
  npdReceiptListQuerySchema,
  npdReceiptTaskIdSchema,
  npdReceiptCommandSchema,
  adminPaymentRefundListSchema,
  adminPaymentRefundDetailSchema,
  ownerPaymentRefundListSchema,
  ownerPaymentSourceListSchema,
  adminPaymentSourceListSchema,
  adminPaymentSourceQuerySchema,
  paymentRefundListQuerySchema,
  paymentRefundIdSchema,
  createPaymentRefundSchema,
  reconcilePaymentRefundSchema,
  paymentAdmissionCommandSchema,
  paymentAdmissionStatusSchema,
  paymentAdmissionUserStatusSchema,
  completionResponseSchema,
  dashboardResponseSchema,
  okResponseSchema,
  startResponseSchema,
  messageIdSchema,
  setMessageFavoriteSchema,
  messageFavoriteResultSchema,
  favoriteMessagesPageSchema,
  personalPlanIdSchema,
  personalPlanQuerySchema,
  createPersonalPlanItemSchema,
  updatePersonalPlanItemSchema,
  removePersonalPlanItemSchema,
  personalPlanPageSchema,
  personalPlanItemResultSchema,
  personalPlanRemoveResultSchema,
  conversationStartSchema,
  conversationListQuerySchema,
  conversationMessagesQuerySchema,
  conversationMessagesResponseSchema,
  conversationHistoryIdSchema,
  conversationIdSchema,
  conversationListResponseSchema,
  conversationDetailResponseSchema,
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  supportsContractVersion,
  type ApiErrorResponse,
  type AccountRole,
  type AiConsentInput,
  type AiRoutingInput,
  type AiBudgetInput,
  type AiCreditGrant,
  type AiCreditReconcile,
  type CreateTopupInput,
  type NpdReceiptListQuery,
  type NpdReceiptCommand,
  type PaymentRefundListQuery,
  type CreatePaymentRefundInput,
  type ReconcilePaymentRefundInput,
  type PaymentAdmissionCommand,
  type Questionnaire,
  type AgentKey,
  type StreamEvent,
  type CreatePersonalPlanItem,
  type UpdatePersonalPlanItem,
  type ServiceConsentChoice,
} from "@citygo/contracts";
import {
  ApiError,
  cancelBody,
  clientError,
  clientLimits,
  mediaType,
  operation,
  readJson,
  type ClientLimits,
  type Operation,
} from "./transport.js";
import { readEvents } from "./sse.js";
export {
  ApiError,
  clientDefaults,
  type ClientLimits,
  type ClientErrorCode,
} from "./transport.js";
export {
  createSessionGuard,
  createSessionStorage,
  clearSessionAndRevoke,
  createSessionLogout,
  notifyBrowserSessionChange,
  subscribeBrowserSessionChange,
  StaleSessionError,
  type SessionTicket,
} from "./session.js";

type ResponseSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};
export function createClient(
  base = "/api",
  options: {
    token?: () => string | null;
    native?: boolean;
    signal?: () => AbortSignal;
    onUnauthorized?: () => void;
    limits?: Partial<ClientLimits>;
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  const limits = clientLimits(options.limits);
  function headers(json = false, streaming = false) {
    const token = options.token?.();
    return {
      Accept: streaming ? "text/event-stream" : "application/json",
      [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.native ? { "X-CityGo-Client": "native" } : {}),
    };
  }
  async function fetchResponse(
    path: string,
    op: Operation,
    body?: unknown,
    streaming = false,
    method?: "PATCH" | "DELETE",
  ) {
    op.check();
    const pending = (options.fetch ?? globalThis.fetch)(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      credentials: "include",
      headers: headers(body !== undefined, streaming),
      signal: op.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then((response) => {
      // A transport ignoring abort can still deliver headers after our deadline.
      if (op.signal.aborted) cancelBody(response);
      else
        op.signal.addEventListener("abort", () => cancelBody(response), {
          once: true,
        });
      return response;
    });
    const response = await op.wait(pending);
    op.check();
    return response;
  }
  async function checkStatus(response: Response, path: string, op: Operation) {
    op.check();
    if (response.status === 401 && !path.startsWith("/v1/auth/"))
      options.onUnauthorized?.();
    op.check();
    if (
      !supportsContractVersion(response.headers.get(CONTRACT_VERSION_HEADER))
    ) {
      throw new ApiError(
        response.status,
        "Версия ответа сервера не поддерживается. Обновите приложение и проверьте состояние перед повтором действия.",
        "invalid_response",
        { code: "CONTRACT_VERSION_UNSUPPORTED", retryable: false },
      );
    }
    if (response.ok) return;
    let message = `Ошибка сервера (HTTP ${response.status}). Проверьте состояние перед повтором действия.`;
    let metadata: ApiErrorResponse | undefined;
    try {
      const data = apiErrorResponseSchema.safeParse(
        await readJson(response, op, Math.min(limits.maxJsonBytes, 16 * 1024)),
      );
      if (data.success) {
        message = data.data.error;
        metadata = data.data;
      }
    } catch {
      op.check(); /* Never expose HTML, raw body or parser errors. */
    }
    throw new ApiError(response.status, message, "http", metadata);
  }
  async function request<T>(
    path: string,
    schema: ResponseSchema<T>,
    body?: unknown,
    method?: "PATCH" | "DELETE",
  ): Promise<T> {
    const op = operation(limits.requestTimeoutMs, [options.signal?.()]);
    let response: Response | undefined;
    try {
      response = await fetchResponse(path, op, body, false, method);
      await checkStatus(response, path, op);
      const result = schema.safeParse(
        await readJson(response, op, limits.maxJsonBytes),
      );
      op.check();
      if (!result.success)
        throw new ApiError(
          response.status,
          "Ответ сервера не соответствует ожидаемому формату",
          "invalid_response",
        );
      return result.data;
    } catch (error) {
      throw clientError(error);
    } finally {
      cancelBody(response);
      op.finish();
    }
  }
  async function paymentRequest(
    path: string,
    expected: { orderId?: string; amountKopeks?: number },
    body?: unknown,
  ) {
    const order = await request(path, topupOrderSchema, body);
    if (
      (expected.orderId !== undefined &&
        order.orderId.toLowerCase() !== expected.orderId.toLowerCase()) ||
      (expected.amountKopeks !== undefined &&
        order.amountKopeks !== expected.amountKopeks)
    ) {
      throw new ApiError(
        200,
        "Ответ сервера не соответствует запрошенному платежу",
        "invalid_response",
      );
    }
    return order;
  }
  function receiptInput<T>(schema: ResponseSchema<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error("Некорректные параметры операции с чеком НПД");
    return parsed.data;
  }
  function emailRegistrationInput<T>(
    schema: ResponseSchema<T>,
    input: unknown,
  ): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error("Некорректные параметры подтверждения email");
    return parsed.data;
  }
  function phoneVerificationInput<T>(
    schema: ResponseSchema<T>,
    input: unknown,
  ): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error("Некорректные параметры подтверждения телефона");
    return parsed.data;
  }
  function passwordRecoveryInput<T>(
    schema: ResponseSchema<T>,
    input: unknown,
  ): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error("Некорректные параметры восстановления доступа");
    return parsed.data;
  }
  async function receiptRequest(taskId: string, command?: NpdReceiptCommand) {
    const id = receiptInput(npdReceiptTaskIdSchema, taskId);
    const body =
      command === undefined
        ? undefined
        : receiptInput(npdReceiptCommandSchema, command);
    const result = await request(
      "/v1/admin/npd/receipts/" +
        encodeURIComponent(id) +
        (body ? "/commands" : ""),
      adminNpdReceiptDetailSchema,
      body,
    );
    if (result.task.id.toLowerCase() !== id.toLowerCase())
      throw new ApiError(
        200,
        "Ответ сервера не соответствует запрошенному чеку",
        "invalid_response",
      );
    return result;
  }
  function refundInput<T>(schema: ResponseSchema<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error("Некорректные параметры операции возврата");
    return parsed.data;
  }
  async function refundRequest(
    path: string,
    expected: {
      id?: string;
      requestId?: string;
      paymentOperationId?: string;
      amountKopeks?: number;
    },
    body?: unknown,
  ) {
    const result = await request(path, adminPaymentRefundDetailSchema, body);
    const refund = result.refund;
    if (
      (expected.id !== undefined &&
        refund.id.toLowerCase() !== expected.id.toLowerCase()) ||
      (expected.requestId !== undefined &&
        refund.requestId.toLowerCase() !== expected.requestId.toLowerCase()) ||
      (expected.paymentOperationId !== undefined &&
        refund.paymentOperationId.toLowerCase() !==
          expected.paymentOperationId.toLowerCase()) ||
      (expected.amountKopeks !== undefined &&
        refund.amountKopeks !== expected.amountKopeks)
    )
      throw new ApiError(
        200,
        "Ответ сервера не соответствует запрошенному возврату",
        "invalid_response",
      );
    return result;
  }
  return {
    passwordRecoveryPolicy: () =>
      request(
        "/v1/auth/password-recovery-policy",
        passwordRecoveryPolicySchema,
      ),
    beginPasswordRecovery: async (email: string) =>
      request(
        "/v1/auth/password-recovery/request",
        passwordRecoveryChallengeSchema,
        passwordRecoveryInput(passwordRecoveryRequestSchema, { email }),
      ),
    resendPasswordRecovery: async (challengeId: string, proof: string) => {
      const input = passwordRecoveryInput(passwordRecoveryResendSchema, {
        challengeId,
        proof,
      });
      const result = await request(
        "/v1/auth/password-recovery/resend",
        passwordRecoveryChallengeSchema,
        input,
      );
      if (
        result.challengeId.toLowerCase() !== input.challengeId.toLowerCase() ||
        result.proof !== input.proof
      )
        throw new ApiError(
          200,
          "Ответ сервера не соответствует запросу восстановления доступа",
          "invalid_response",
        );
      return result;
    },
    confirmPasswordRecovery: async (
      challengeId: string,
      proof: string,
      code: string,
      newPassword: string,
    ) =>
      request(
        "/v1/auth/password-recovery/confirm",
        passwordRecoveryReceiptSchema,
        passwordRecoveryInput(passwordRecoveryConfirmSchema, {
          challengeId,
          proof,
          code,
          newPassword,
        }),
      ),
    registrationPolicy: () =>
      request("/v1/auth/registration-policy", registrationPolicyResponseSchema),
    legalConsentPolicy: () =>
      request("/v1/legal/consent-policy", serviceConsentPolicySchema),
    accountConsents: () =>
      request("/v1/account/consents", serviceConsentStateSchema),
    setAccountConsents: async (input: ServiceConsentChoice) => {
      const choice = serviceConsentChoiceSchema.parse(input);
      const result = await request(
        "/v1/account/consents",
        serviceConsentStateSchema,
        choice,
      );
      if (
        result.policy.version !== choice.policyVersion ||
        !result.personalDataGranted ||
        result.marketingGranted !== choice.marketing ||
        result.serviceConsentRequired
      )
        throw new ApiError(
          200,
          "Ответ сервера не подтверждает выбранные согласия",
          "invalid_response",
        );
      return result;
    },
    beginEmailRegistration: async (
      email: string,
      password: string,
      consents: ServiceConsentChoice,
    ) =>
      request(
        "/v1/auth/email/register",
        emailRegistrationChallengeSchema,
        emailRegistrationInput(registrationWithConsentsSchema, {
          email,
          password,
          consents,
        }),
      ),
    resendEmailRegistration: async (challengeId: string, proof: string) =>
      request(
        "/v1/auth/email/resend",
        emailRegistrationChallengeSchema,
        emailRegistrationInput(emailRegistrationResendSchema, {
          challengeId,
          proof,
        }),
      ),
    confirmEmailRegistration: async (
      challengeId: string,
      proof: string,
      code: string,
    ) =>
      request(
        "/v1/auth/email/confirm",
        options.native ? nativeAuthResponseSchema : authResponseSchema,
        emailRegistrationInput(emailRegistrationConfirmSchema, {
          challengeId,
          proof,
          code,
        }),
      ),
    phoneVerificationPolicy: () =>
      request("/v1/phone-verification/policy", phoneVerificationPolicySchema),
    beginPhoneVerification: async (
      phone: string,
      expectedDeliveryProvider: "sms_ru" | "prosto_sms",
    ) =>
      request(
        "/v1/phone-verification/start",
        phoneVerificationChallengeSchema,
        phoneVerificationInput(phoneVerificationStartSchema, {
          phone,
          expectedDeliveryProvider,
        }),
      ),
    resendPhoneVerification: async (
      challengeId: string,
      proof: string,
      phone: string,
      expectedDeliveryProvider: "sms_ru" | "prosto_sms",
    ) => {
      const input = phoneVerificationInput(phoneVerificationResendSchema, {
        challengeId,
        proof,
        phone,
        expectedDeliveryProvider,
      });
      const result = await request(
        "/v1/phone-verification/resend",
        phoneVerificationChallengeSchema,
        input,
      );
      if (
        result.challengeId.toLowerCase() !== input.challengeId.toLowerCase() ||
        result.proof !== input.proof
      )
        throw new ApiError(
          200,
          "Ответ сервера не соответствует запросу подтверждения телефона",
          "invalid_response",
        );
      return result;
    },
    confirmPhoneVerification: async (
      challengeId: string,
      proof: string,
      phone: string,
      code: string,
    ) =>
      request(
        "/v1/phone-verification/confirm",
        phoneVerificationReceiptSchema,
        phoneVerificationInput(phoneVerificationConfirmSchema, {
          challengeId,
          proof,
          phone,
          code,
        }),
      ),
    auth: async (
      mode: "login" | "register",
      email: string,
      password: string,
      consents?: ServiceConsentChoice,
    ) =>
      request(
        "/v1/auth/" + mode,
        options.native ? nativeAuthResponseSchema : authResponseSchema,
        mode === "register"
          ? emailRegistrationInput(registrationWithConsentsSchema, {
              email,
              password,
              consents,
            })
          : { email, password },
      ),
    logout: () => request("/v1/auth/logout", okResponseSchema, {}),
    changePassword: (currentPassword: string, password: string) =>
      request(
        "/v1/auth/password",
        options.native ? nativeAuthResponseSchema : authResponseSchema,
        { currentPassword, password },
      ),
    accountUsers: () => request("/v1/admin/accounts", adminUsersResponseSchema),
    adminNpdReceipts: (input: Partial<NpdReceiptListQuery> = {}) => {
      const query = receiptInput(npdReceiptListQuerySchema, input);
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.status) search.set("status", query.status);
      if (query.after) search.set("after", query.after);
      return request(
        "/v1/admin/npd/receipts?" + search.toString(),
        adminNpdReceiptListSchema,
      );
    },
    adminNpdReceipt: (taskId: string) => receiptRequest(taskId),
    commandNpdReceipt: (taskId: string, command: NpdReceiptCommand) =>
      receiptRequest(taskId, command),
    npdReceipts: () =>
      request("/v1/payments/receipts", ownerNpdReceiptListSchema),
    paymentAdmission: () =>
      request("/v1/admin/payments/admission", paymentAdmissionStatusSchema),
    commandPaymentAdmission: async (input: PaymentAdmissionCommand) => {
      const parsed = paymentAdmissionCommandSchema.safeParse(input);
      if (!parsed.success)
        throw new Error("Некорректная команда допуска оплаты");
      const result = await request(
        "/v1/admin/payments/admission/commands",
        paymentAdmissionStatusSchema,
        parsed.data,
      );
      if (result.revision <= parsed.data.expectedRevision)
        throw new ApiError(
          200,
          "Ответ сервера не подтверждает новую ревизию допуска оплаты. Обновите состояние перед повтором действия.",
          "invalid_response",
        );
      return result;
    },
    paymentAvailability: () =>
      request("/v1/payments/availability", paymentAdmissionUserStatusSchema),
    adminPaymentRefunds: (input: Partial<PaymentRefundListQuery> = {}) => {
      const query = refundInput(paymentRefundListQuerySchema, input);
      const search = new URLSearchParams({ limit: String(query.limit) });
      if (query.status) search.set("status", query.status);
      if (query.after) search.set("after", query.after);
      return request(
        "/v1/admin/payments/refunds?" + search.toString(),
        adminPaymentRefundListSchema,
      );
    },
    adminPaymentRefund: (refundId: string) => {
      const id = refundInput(paymentRefundIdSchema, refundId);
      return refundRequest(
        "/v1/admin/payments/refunds/" + encodeURIComponent(id),
        { id },
      );
    },
    createPaymentRefund: (input: CreatePaymentRefundInput) => {
      const parsed = refundInput(createPaymentRefundSchema, input);
      return refundRequest("/v1/admin/payments/refunds", parsed, parsed);
    },
    submitPaymentRefund: (refundId: string) => {
      const id = refundInput(paymentRefundIdSchema, refundId);
      return refundRequest(
        "/v1/admin/payments/refunds/" + encodeURIComponent(id) + "/submit",
        { id },
        {},
      );
    },
    reconcilePaymentRefund: (
      refundId: string,
      input: ReconcilePaymentRefundInput = {},
    ) => {
      const id = refundInput(paymentRefundIdSchema, refundId);
      const parsed = refundInput(reconcilePaymentRefundSchema, input);
      return refundRequest(
        "/v1/admin/payments/refunds/" + encodeURIComponent(id) + "/reconcile",
        { id },
        parsed,
      );
    },
    paymentRefunds: () =>
      request("/v1/payments/refunds", ownerPaymentRefundListSchema),
    paymentSources: () =>
      request("/v1/payments/sources", ownerPaymentSourceListSchema),
    adminPaymentSources: async (userId: string) => {
      const parsed = refundInput(adminPaymentSourceQuerySchema, { userId });
      const result = await request(
        "/v1/admin/payments/sources?" + new URLSearchParams(parsed).toString(),
        adminPaymentSourceListSchema,
      );
      if (result.sources.some((source) => source.userId !== parsed.userId))
        throw new ApiError(
          200,
          "Ответ сервера не соответствует запрошенному аккаунту",
          "invalid_response",
        );
      return result;
    },
    setAccountRole: (userId: string, role: AccountRole) =>
      request("/v1/admin/accounts/role", accountUserResponseSchema, {
        userId,
        role,
      }),
    dashboard: () => request("/v1/dashboard", dashboardResponseSchema),
    personalPlan: async (before?: string) => {
      const query = personalPlanQuerySchema.parse(
        before === undefined ? {} : { before },
      );
      const result = await request(
        "/v1/personal-plan" +
          (query.before === undefined ? "" : "?before=" + query.before),
        personalPlanPageSchema,
      );
      if (
        query.before !== undefined &&
        result.items.some((item) => BigInt(item.id) >= BigInt(query.before!))
      )
        throw new ApiError(
          200,
          "Ответ сервера не соответствует странице личного плана",
          "invalid_response",
        );
      return result;
    },
    createPersonalPlanItem: async (input: CreatePersonalPlanItem) => {
      const body = createPersonalPlanItemSchema.parse(input);
      const result = await request(
        "/v1/personal-plan",
        personalPlanItemResultSchema,
        body,
      );
      // An idempotent replay may return an edited current item. Its immutable
      // original source must still agree with the frozen creation request.
      if (result.item.source.messageId !== body.sourceMessageId)
        throw new ApiError(
          200,
          "Ответ сервера не соответствует источнику шага",
          "invalid_response",
        );
      return result;
    },
    updatePersonalPlanItem: async (
      itemId: string,
      input: UpdatePersonalPlanItem,
    ) => {
      const id = personalPlanIdSchema.parse(itemId);
      const body = updatePersonalPlanItemSchema.parse(input);
      const result = await request(
        "/v1/personal-plan/" + id,
        personalPlanItemResultSchema,
        body,
        "PATCH",
      );
      if (
        result.item.id !== id ||
        result.item.revision !== body.expectedRevision + 1 ||
        result.item.title !== body.title ||
        result.item.details !== body.details ||
        result.item.status !== body.status
      )
        throw new ApiError(
          200,
          "Ответ сервера не подтверждает изменение шага",
          "invalid_response",
        );
      return result;
    },
    removePersonalPlanItem: async (
      itemId: string,
      expectedRevision: number,
    ) => {
      const id = personalPlanIdSchema.parse(itemId);
      const body = removePersonalPlanItemSchema.parse({ expectedRevision });
      const result = await request(
        "/v1/personal-plan/" + id,
        personalPlanRemoveResultSchema,
        body,
        "DELETE",
      );
      if (result.itemId !== id)
        throw new ApiError(
          200,
          "Ответ сервера не подтверждает удаление шага",
          "invalid_response",
        );
      return result;
    },
    favoriteMessages: async (before?: string) =>
      request(
        "/v1/messages/favorites" +
          (before !== undefined
            ? "?before=" + messageIdSchema.parse(before)
            : ""),
        favoriteMessagesPageSchema,
      ),
    setMessageFavorite: async (messageId: string, saved: boolean) => {
      messageIdSchema.parse(messageId);
      setMessageFavoriteSchema.parse({ saved });
      const result = await request(
        "/v1/messages/" + messageId + "/favorite",
        messageFavoriteResultSchema,
        { saved },
      );
      if (result.messageId !== messageId || result.saved !== saved)
        throw new ApiError(
          200,
          "Ответ сервера не соответствует сообщению",
          "invalid_response",
        );
      return result;
    },
    startConversation: async (agentKey?: AgentKey) => {
      const input = conversationStartSchema.parse(
        agentKey === undefined ? {} : { agentKey },
      );
      const result = await request(
        "/v1/conversations/start",
        startResponseSchema,
        input,
      );
      if (
        input.agentKey !== undefined &&
        (result.agentKey !== input.agentKey ||
          result.assistantKey !== input.agentKey ||
          result.closed !== false)
      )
        throw new ApiError(
          200,
          "Ответ сервера не соответствует выбранному помощнику",
          "invalid_response",
        );
      return result;
    },
    conversations: async (before?: string) => {
      const query = conversationListQuerySchema.parse(
        before === undefined ? {} : { before },
      );
      const result = await request(
        "/v1/conversations" +
          (query.before !== undefined ? "?before=" + query.before : ""),
        conversationListResponseSchema,
      );
      if (
        result.conversations.some(
          (thread, index, rows) =>
            (query.before !== undefined &&
              BigInt(thread.id) >= BigInt(query.before)) ||
            (index > 0 && BigInt(thread.id) >= BigInt(rows[index - 1]!.id)),
        ) ||
        (result.nextCursor !== null &&
          result.nextCursor !== result.conversations.at(-1)?.id)
      )
        throw new ApiError(
          200,
          "Ответ сервера не соответствует странице диалогов",
          "invalid_response",
        );
      return result;
    },
    conversation: async (conversationId: string) => {
      const id = conversationIdSchema.parse(conversationId);
      const result = await request(
        "/v1/conversations/" + id,
        conversationDetailResponseSchema,
      );
      if (result.thread.id !== id)
        throw new ApiError(
          200,
          "Ответ сервера не соответствует выбранному диалогу",
          "invalid_response",
        );
      return result;
    },
    conversationMessages: async (conversationId: string, before?: string) => {
      const id = conversationHistoryIdSchema.parse(conversationId);
      const query = conversationMessagesQuerySchema.parse(
        before === undefined ? {} : { before },
      );
      const result = await request(
        "/v1/conversations/" +
          id +
          "/messages" +
          (query.before === undefined ? "" : "?before=" + query.before),
        conversationMessagesResponseSchema,
      );
      if (
        result.threadId !== id ||
        result.messages.some(
          (message, index, messages) =>
            (query.before !== undefined &&
              BigInt(message.id) >= BigInt(query.before)) ||
            (index > 0 &&
              BigInt(messages[index - 1]!.id) >= BigInt(message.id)),
        ) ||
        (result.nextCursor !== null &&
          (result.messages.length !== 100 ||
            result.nextCursor !== result.messages[0]?.id))
      )
        throw new ApiError(
          200,
          "Ответ сервера не соответствует странице истории диалога",
          "invalid_response",
        );
      return result;
    },
    aiConsent: (input: AiConsentInput) =>
      request("/v1/ai/consent", okResponseSchema, input),
    aiControl: () => request("/v1/admin/ai", aiControlResponseSchema),
    aiCredit: () => request("/v1/ai/credit", aiCreditResponseSchema),
    createTopup: (input: CreateTopupInput) => {
      const parsed = createTopupSchema.parse(input);
      return paymentRequest(
        "/v1/payments/topups",
        { amountKopeks: parsed.amountKopeks },
        parsed,
      );
    },
    topupOrder: (orderId: string) =>
      paymentRequest("/v1/payments/topups/" + encodeURIComponent(orderId), {
        orderId,
      }),
    topupAttempt: (requestId: string) =>
      paymentRequest(
        "/v1/payments/topup-attempts/" +
          encodeURIComponent(
            createTopupSchema.shape.requestId.parse(requestId),
          ),
        {},
      ),
    reconcileTopup: (orderId: string) =>
      paymentRequest(
        "/v1/payments/topups/" + encodeURIComponent(orderId) + "/reconcile",
        { orderId },
        {},
      ),
    grantWelcomeCredit: (input: AiCreditGrant) =>
      request("/v1/admin/ai/credit/welcome", aiCreditResponseSchema, input),
    reconcileCredit: (input: AiCreditReconcile) =>
      request("/v1/admin/ai/credit/reconcile", aiCreditResponseSchema, input),
    setAiRouting: (input: AiRoutingInput) =>
      request("/v1/admin/ai", aiRoutingResponseSchema, input),
    setAiBudget: (input: AiBudgetInput) =>
      request("/v1/admin/ai/budget", aiBudgetSettingsSchema, input),
    questionnaire: (profile: Questionnaire) =>
      request("/v1/questionnaire", okResponseSchema, profile),
    start: (id: string) =>
      request(
        "/v1/quests/" + encodeURIComponent(id) + "/start",
        startResponseSchema,
        {},
      ),
    complete: (id: string) =>
      request(
        "/v1/quests/" + encodeURIComponent(id) + "/complete",
        completionResponseSchema,
        { confirmed: true },
      ),
    admin: () => request("/v1/admin/overview", adminOverviewResponseSchema),
    async stream(
      threadId: string,
      text: string,
      requestId: string,
      onEvent: (event: StreamEvent) => void,
      signal?: AbortSignal,
      policyId?: string,
      creditReservationMode?: "full" | "fixed5_overdraft",
    ) {
      const path = "/v1/threads/" + encodeURIComponent(threadId) + "/messages";
      const op = operation(
        limits.streamTimeoutMs,
        [options.signal?.(), signal],
        limits.streamIdleTimeoutMs,
      );
      let response: Response | undefined;
      try {
        response = await fetchResponse(
          path,
          op,
          { text, requestId, policyId, creditReservationMode },
          true,
        );
        await checkStatus(response, path, op);
        if (
          response.status !== 200 ||
          mediaType(response) !== "text/event-stream"
        )
          throw new ApiError(
            response.status,
            "Сервер вернул ответ неподдерживаемого формата",
            "invalid_content_type",
          );
        await readEvents(response, op, limits, onEvent);
      } catch (error) {
        throw clientError(error);
      } finally {
        cancelBody(response);
        op.finish();
      }
    },
  };
}

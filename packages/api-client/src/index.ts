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
  completionResponseSchema,
  dashboardResponseSchema,
  okResponseSchema,
  startResponseSchema,
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
  type Questionnaire,
  type StreamEvent,
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
  ) {
    op.check();
    const pending = (options.fetch ?? globalThis.fetch)(base + path, {
      method: body === undefined ? "GET" : "POST",
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
  ): Promise<T> {
    const op = operation(limits.requestTimeoutMs, [options.signal?.()]);
    let response: Response | undefined;
    try {
      response = await fetchResponse(path, op, body);
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
  return {
    auth: (mode: "login" | "register", email: string, password: string) =>
      request(
        "/v1/auth/" + mode,
        options.native ? nativeAuthResponseSchema : authResponseSchema,
        { email, password },
      ),
    logout: () => request("/v1/auth/logout", okResponseSchema, {}),
    changePassword: (currentPassword: string, password: string) =>
      request(
        "/v1/auth/password",
        options.native ? nativeAuthResponseSchema : authResponseSchema,
        { currentPassword, password },
      ),
    accountUsers: () => request("/v1/admin/accounts", adminUsersResponseSchema),
    setAccountRole: (userId: string, role: AccountRole) =>
      request("/v1/admin/accounts/role", accountUserResponseSchema, {
        userId,
        role,
      }),
    dashboard: () => request("/v1/dashboard", dashboardResponseSchema),
    startConversation: () =>
      request("/v1/conversations/start", startResponseSchema, {}),
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
          { text, requestId, policyId },
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

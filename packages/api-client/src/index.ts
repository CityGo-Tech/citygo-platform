import type {
  AiConsentInput,
  AiRoutingInput,
  AiRouting,
  AiBudgetInput,
  AiBudgetSettings,
  AiControlStatus,
  Dashboard,
  Questionnaire,
  StreamEvent,
} from "@citygo/contracts";
export {
  createSessionGuard,
  createSessionStorage,
  clearSessionAndRevoke,
  notifyBrowserSessionChange,
  subscribeBrowserSessionChange,
  StaleSessionError,
  type SessionTicket,
} from "./session.js";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function createClient(
  base = "/api",
  options: {
    token?: () => string | null;
    native?: boolean;
    signal?: () => AbortSignal;
    onUnauthorized?: () => void;
  } = {},
) {
  function check(signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Запрос прежней сессии отменён");
  }
  function unauthorized(status: number, signal?: AbortSignal) {
    check(signal);
    if (status === 401) options.onUnauthorized?.();
  }
  function headers(json = false) {
    const token = options.token?.();
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.native ? { "X-CityGo-Client": "native" } : {}),
    };
  }
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const signal = options.signal?.();
    check(signal);
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: headers(body !== undefined),
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    check(signal);
    // Bad login credentials are not expiry of an authenticated session.
    if (!path.startsWith("/v1/auth/")) unauthorized(response.status, signal);
    const data = await response.json();
    check(signal);
    if (!response.ok)
      throw new ApiError(response.status, data.error ?? "Ошибка запроса");
    return data as T;
  }
  return {
    auth: (mode: "login" | "register", email: string, password: string) =>
      request<{ token?: string }>("/v1/auth/" + mode, { email, password }),
    logout: () => request("/v1/auth/logout", {}),
    dashboard: () => request<Dashboard>("/v1/dashboard"),
    aiConsent: (input: AiConsentInput) =>
      request<{ ok: true }>("/v1/ai/consent", input),
    aiControl: () => request<AiControlStatus>("/v1/admin/ai"),
    setAiRouting: (input: AiRoutingInput) =>
      request<AiRouting>("/v1/admin/ai", input),
    setAiBudget: (input: AiBudgetInput) =>
      request<AiBudgetSettings>("/v1/admin/ai/budget", input),
    questionnaire: (profile: Questionnaire) =>
      request("/v1/questionnaire", profile),
    start: (id: string) =>
      request<{ id: string }>("/v1/quests/" + id + "/start", {}),
    complete: (id: string) =>
      request<{ awarded: number }>("/v1/quests/" + id + "/complete", {
        confirmed: true,
      }),
    admin: () =>
      request<{
        counts: { users: number; completed: number; xp: number };
        pendingHuman: { id: string; thread_id: string; reason: string }[];
      }>("/v1/admin/overview"),
    async stream(
      threadId: string,
      text: string,
      requestId: string,
      onEvent: (event: StreamEvent) => void,
      signal?: AbortSignal,
      policyId?: string,
    ) {
      const lifetime = options.signal?.();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const sources = [lifetime, signal].filter((value): value is AbortSignal =>
        Boolean(value),
      );
      for (const source of sources) {
        source.addEventListener("abort", cancel, { once: true });
        if (source.aborted) cancel();
      }
      try {
        check(controller.signal);
        const response = await fetch(
          base + "/v1/threads/" + threadId + "/messages",
          {
            method: "POST",
            credentials: "include",
            headers: headers(true),
            body: JSON.stringify({ text, requestId, policyId }),
            signal: controller.signal,
          },
        );
        check(controller.signal);
        unauthorized(response.status, lifetime);
        if (!response.ok) {
          const data = await response.json();
          throw new ApiError(response.status, data.error ?? "Чат недоступен");
        }
        if (!response.body)
          throw new Error("Streaming не поддерживается этим клиентом");
        const reader = response.body.getReader();
        const cancelReader = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", cancelReader, {
          once: true,
        });
        const decoder = new TextDecoder();
        let buffer = "";
        let done = false;
        try {
          while (true) {
            const chunk = await reader.read();
            check(controller.signal);
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const event = JSON.parse(line.slice(6)) as StreamEvent;
                check(controller.signal);
                if (event.type === "done") done = true;
                onEvent(event);
                if (event.type === "error") throw new Error(event.message);
              }
            }
            if (chunk.done) break;
          }
          if (!done)
            throw new Error("Соединение прервано до завершения ответа");
        } finally {
          controller.signal.removeEventListener("abort", cancelReader);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally {
        for (const source of sources)
          source.removeEventListener("abort", cancel);
      }
    },
  };
}

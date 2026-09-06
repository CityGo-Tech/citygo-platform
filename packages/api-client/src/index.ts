import type { Dashboard, Questionnaire, StreamEvent } from "@citygo/contracts";
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
  options: { token?: () => string | null; native?: boolean } = {},
) {
  function headers(json = false) {
    const token = options.token?.();
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(options.native ? { "X-CityGo-Client": "native" } : {}),
    };
  }
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(response.status, data.error ?? "Ошибка запроса");
    return data as T;
  }
  return {
    auth: (mode: "login" | "register", email: string, password: string) =>
      request<{ token?: string }>("/v1/auth/" + mode, { email, password }),
    logout: () => request("/v1/auth/logout", {}),
    dashboard: () => request<Dashboard>("/v1/dashboard"),
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
    ) {
      const response = await fetch(
        base + "/v1/threads/" + threadId + "/messages",
        {
          method: "POST",
          credentials: "include",
          headers: headers(true),
          body: JSON.stringify({ text, requestId }),
          signal,
        },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new ApiError(response.status, data.error ?? "Чат недоступен");
      }
      if (!response.body)
        throw new Error("Streaming не поддерживается этим клиентом");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      try {
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const event = JSON.parse(line.slice(6)) as StreamEvent;
              if (event.type === "done") done = true;
              onEvent(event);
              if (event.type === "error") throw new Error(event.message);
            }
          }
          if (chunk.done) break;
        }
        if (!done) throw new Error("Соединение прервано до завершения ответа");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}

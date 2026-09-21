export type ClientErrorCode =
  | "http"
  | "network"
  | "timeout"
  | "idle_timeout"
  | "aborted"
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_response"
  | "response_too_large"
  | "invalid_stream"
  | "stream_interrupted"
  | "stream_error";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: ClientErrorCode = "http",
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export const clientDefaults = Object.freeze({
  requestTimeoutMs: 30_000,
  // Server RouterAI deadline can be 240s; do not cut its reasoning short.
  streamTimeoutMs: 300_000,
  streamIdleTimeoutMs: 45_000,
  maxJsonBytes: 8 * 1024 * 1024,
  maxStreamBytes: 8 * 1024 * 1024,
  maxFrameBytes: 256 * 1024,
  maxStreamEvents: 100_000,
});
export type ClientLimits = { [Key in keyof typeof clientDefaults]: number };
export function clientLimits(input: Partial<ClientLimits> = {}): ClientLimits {
  const limits = { ...clientDefaults, ...input };
  for (const key of Object.keys(limits) as (keyof ClientLimits)[]) {
    // A caller may tighten, but cannot accidentally disable a safety bound.
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > clientDefaults[key]
    )
      throw new Error(`Invalid client limit: ${key}`);
  }
  return limits;
}

export function operation(
  timeoutMs: number,
  sources: (AbortSignal | undefined)[],
  idleMs?: number,
) {
  const controller = new AbortController();
  let failure: ApiError | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  function stop(error: ApiError) {
    if (controller.signal.aborted) return;
    failure = error;
    controller.abort();
  }
  const cancel = () =>
    stop(
      new ApiError(
        0,
        "Запрос прежней сессии или текущий запрос отменён",
        "aborted",
      ),
    );
  for (const signal of sources) {
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  }
  const deadline = setTimeout(
    () =>
      stop(
        new ApiError(
          0,
          "Время ожидания ответа истекло. Проверьте состояние перед повтором действия.",
          "timeout",
        ),
      ),
    timeoutMs,
  );
  function touch() {
    if (!idleMs || controller.signal.aborted) return;
    clearTimeout(idle);
    idle = setTimeout(
      () =>
        stop(
          new ApiError(
            0,
            "Соединение не передаёт данные. Ответ не подтверждён как завершённый.",
            "idle_timeout",
          ),
        ),
      idleMs,
    );
  }
  function check() {
    if (failure) throw failure;
  }
  touch();
  return {
    signal: controller.signal,
    check,
    touch,
    // Abort must settle even if a native transport ignores its signal. Every
    // awaited operation has a rejection handler, including a late losing result.
    async wait<T>(promise: Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(failure);
        const cleanup = () =>
          controller.signal.removeEventListener("abort", aborted);
        controller.signal.addEventListener("abort", aborted, { once: true });
        promise.then(
          (value) => {
            cleanup();
            if (failure) reject(failure);
            else resolve(value);
          },
          (error: unknown) => {
            cleanup();
            reject(failure ?? error);
          },
        );
        if (failure) {
          cleanup();
          reject(failure);
        }
      });
    },
    finish() {
      clearTimeout(deadline);
      clearTimeout(idle);
      for (const signal of sources)
        signal?.removeEventListener("abort", cancel);
      // Cancel any still-running transport without invalidating the user session.
      controller.abort();
    },
  };
}
export type Operation = ReturnType<typeof operation>;
export function cancelBody(response?: Response) {
  try {
    void response?.body?.cancel().catch(() => {});
  } catch {
    /* Already locked/closed. */
  }
}
export async function* readBytes(
  response: Response,
  op: Operation,
  maxBytes: number,
) {
  if (!response.body)
    throw new ApiError(
      0,
      "Клиент не поддерживает чтение ответа",
      "invalid_response",
    );
  const reader = response.body.getReader();
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  op.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      op.check();
      const chunk = await op.wait(reader.read());
      op.check();
      if (chunk.done) return;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new ApiError(
          0,
          "Ответ превышает допустимый размер",
          "response_too_large",
        );
      if (chunk.value.byteLength) {
        op.touch();
        yield chunk.value;
      }
    }
  } finally {
    op.signal.removeEventListener("abort", cancel);
    // An uncooperative cancellation promise must not keep the UI busy forever.
    cancel();
    try {
      reader.releaseLock();
    } catch {
      /* A native reader may still be settling. */
    }
  }
}
export function mediaType(response: Response) {
  return response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}
export async function readJson(
  response: Response,
  op: Operation,
  maxBytes: number,
): Promise<unknown> {
  const type = mediaType(response);
  if (
    !type ||
    !(
      type === "application/json" ||
      /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type)
    )
  )
    throw new ApiError(
      response.status,
      "Сервер вернул ответ неподдерживаемого формата",
      "invalid_content_type",
    );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for await (const bytes of readBytes(response, op, maxBytes)) {
    try {
      text += decoder.decode(bytes, { stream: true });
    } catch {
      throw new ApiError(
        response.status,
        "Не удалось прочитать ответ сервера",
        "invalid_json",
      );
    }
  }
  op.check();
  try {
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(
      response.status,
      "Не удалось прочитать ответ сервера",
      "invalid_json",
    );
  }
}
export function clientError(error: unknown) {
  return error instanceof ApiError
    ? error
    : new ApiError(
        0,
        "Не удалось связаться с сервером. Проверьте состояние перед повтором действия.",
        "network",
      );
}

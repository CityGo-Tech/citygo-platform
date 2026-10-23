// Server-only transport preparation. Construction sends nothing. The agreed
// sender, OTP route and paid terms must be approved separately before live use.
const ENDPOINT = "https://ssl.bs00.ru/";
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REJECTIONS = new Set([
  3, 5, 7, 602, 605, 607, 608, 609, 610, 611, 617, 618, 620, 621, 622, 623, 624,
  625, 626, 627, 628, 629, 631, 632,
]);

export type ProstoSmsDeliveryInput = {
  phone: string;
  code: string;
  signal: AbortSignal;
};
export type ProstoSmsDeliveryOptions = {
  apiKey: string;
  from: string;
  fetch?: typeof globalThis.fetch;
};
export type ProstoSmsDeliveryResult = {
  provider: "prosto_sms";
  mode: "live";
  accepted: true;
  simulated: false;
  providerMessageId: string;
};
export type ProstoSmsFailureCode =
  | "configuration"
  | "invalid_input"
  | "aborted"
  | "timeout"
  | "transport"
  | "http"
  | "invalid_response"
  | "rejected";
export class ProstoSmsDeliveryError extends Error {
  constructor(
    readonly code: ProstoSmsFailureCode,
    readonly outcome: "not_dispatched" | "unknown" | "rejected",
  ) {
    // Never expose key, phone, OTP, provider text/body/URL or exception causes.
    super("Не удалось отправить код подтверждения телефона.");
    this.name = "ProstoSmsDeliveryError";
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: object, expected: string[]) {
  return Object.keys(value).every((key) => expected.includes(key));
}
function messageId(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === "string" && /^[1-9][0-9]{0,31}(?![\s\S])/.test(value))
    return value;
  return undefined;
}
function credits(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    /^[0-9]+(?:\.[0-9]+)?(?![\s\S])/.test(value) &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  );
}
function rejected(msg: Record<string, unknown>) {
  const code =
    typeof msg.err_code === "number" && Number.isInteger(msg.err_code)
      ? msg.err_code
      : typeof msg.err_code === "string" &&
          /^[1-9][0-9]{0,2}(?![\s\S])/.test(msg.err_code)
        ? Number(msg.err_code)
        : undefined;
  // 99 (unfinished transaction) and 699 (connection failure) are deliberately
  // unknown, not assertions that an SMS was never sent. No failure is retried.
  return (
    (msg.type === "error" || msg.type === "notice") &&
    code !== undefined &&
    REJECTIONS.has(code)
  );
}
function cancel(response: Response) {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // A locked reader owns cleanup. Do not wait for an abort-ignoring upstream.
  }
}

export function createProstoSmsDelivery(options: ProstoSmsDeliveryOptions) {
  if (
    !object(options) ||
    !keys(options, ["apiKey", "from", "fetch"]) ||
    typeof options.apiKey !== "string" ||
    !/^[\x21-\x7e]{16,256}(?![\s\S])/.test(options.apiKey) ||
    typeof options.from !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,10}(?![\s\S])/.test(options.from) ||
    (options.fetch !== undefined && typeof options.fetch !== "function")
  )
    throw new ProstoSmsDeliveryError("configuration", "not_dispatched");
  // Snapshot immutable settings; neither callers nor provider defaults may
  // change recipients, sender or credentials after construction.
  const { apiKey, from } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    provider: "prosto_sms" as const,
    mode: "live" as const,
    async send(
      input: ProstoSmsDeliveryInput,
    ): Promise<ProstoSmsDeliveryResult> {
      if (
        !object(input) ||
        !keys(input, ["phone", "code", "signal"]) ||
        Object.keys(input).length !== 3 ||
        typeof input.phone !== "string" ||
        !/^79[0-9]{9}(?![\s\S])/.test(input.phone) ||
        typeof input.code !== "string" ||
        !/^[0-9]{6}(?![\s\S])/.test(input.code) ||
        !(input.signal instanceof AbortSignal)
      )
        throw new ProstoSmsDeliveryError("invalid_input", "not_dispatched");
      if (input.signal.aborted)
        throw new ProstoSmsDeliveryError("aborted", "not_dispatched");
      const text = `CityGo: код подтверждения номера ${input.code}. Никому не сообщайте.`;
      if (text.length > 70)
        throw new ProstoSmsDeliveryError("configuration", "not_dispatched");
      const body = new URLSearchParams({
        method: "push_msg",
        format: "json",
        key: apiKey,
        phone: input.phone,
        text,
        sender_name: from,
        priority: "1",
      });
      const controller = new AbortController();
      let failure: "aborted" | "timeout" | undefined;
      let dispatched = false;
      const abort = () => {
        failure ??= "aborted";
        controller.abort();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const timer = setTimeout(() => {
        failure ??= "timeout";
        controller.abort();
      }, TIMEOUT_MS);
      const stopped = () =>
        new ProstoSmsDeliveryError(
          failure ?? "transport",
          dispatched ? "unknown" : "not_dispatched",
        );
      const check = () => {
        if (failure) throw stopped();
      };
      function wait<T>(pending: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(stopped());
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          // Both late outcomes are consumed; even abort-ignoring fetch/read
          // settles the caller deadline without an unhandled rejection.
          pending.then(
            (value) => {
              controller.signal.removeEventListener("abort", onAbort);
              if (failure) reject(stopped());
              else resolve(value);
            },
            () => {
              controller.signal.removeEventListener("abort", onAbort);
              reject(stopped());
            },
          );
          if (controller.signal.aborted) onAbort();
        });
      }
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const chunks: Buffer[] = [];
      try {
        check();
        dispatched = true;
        response = await wait<Response>(
          fetch(ENDPOINT, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            },
            body: body.toString(),
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
          }).then((value) => {
            if (controller.signal.aborted) cancel(value);
            return value;
          }),
        );
        check();
        if (response.redirected || (response.url && response.url !== ENDPOINT))
          throw new ProstoSmsDeliveryError("invalid_response", "unknown");
        if (response.status !== 200)
          throw new ProstoSmsDeliveryError("http", "unknown");
        // The API does not promise a response MIME. Parse bounded UTF-8 JSON
        // without executing HTML or treating a MIME label as delivery proof.
        if (!response.body)
          throw new ProstoSmsDeliveryError("invalid_response", "unknown");
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^[0-9]{1,12}(?![\s\S])/.test(declared) ||
            Number(declared) > MAX_RESPONSE_BYTES)
        )
          throw new ProstoSmsDeliveryError("invalid_response", "unknown");
        reader = response.body.getReader();
        let size = 0;
        for (;;) {
          const item = await wait(reader.read());
          check();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > MAX_RESPONSE_BYTES)
            throw new ProstoSmsDeliveryError("invalid_response", "unknown");
          chunks.push(Buffer.from(item.value));
        }
        const raw = Buffer.concat(chunks);
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(raw),
          );
        } finally {
          raw.fill(0);
        }
        check();
        if (!object(value) || !object(value.response))
          throw new ProstoSmsDeliveryError("invalid_response", "unknown");
        const { msg, data } = value.response;
        if (!object(msg))
          throw new ProstoSmsDeliveryError("invalid_response", "unknown");
        if (
          (msg.err_code !== "0" && msg.err_code !== 0) ||
          msg.type !== "message"
        )
          throw new ProstoSmsDeliveryError(
            rejected(msg) ? "rejected" : "invalid_response",
            rejected(msg) ? "rejected" : "unknown",
          );
        const id = object(data) ? messageId(data.id) : undefined;
        if (
          !object(data) ||
          !id ||
          data.n_raw_sms !== 1 ||
          !credits(data.credits) ||
          data.sender_name !== from
        )
          throw new ProstoSmsDeliveryError("invalid_response", "unknown");
        // Accepted is not delivered or verified. Only the separate OTP
        // confirmation transaction may establish ownership and grant credit.
        return {
          provider: "prosto_sms",
          mode: "live",
          accepted: true,
          simulated: false,
          providerMessageId: id,
        };
      } catch (error) {
        if (error instanceof ProstoSmsDeliveryError) throw error;
        throw new ProstoSmsDeliveryError(
          failure ?? (response ? "invalid_response" : "transport"),
          dispatched ? "unknown" : "not_dispatched",
        );
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        controller.abort();
        for (const chunk of chunks) chunk.fill(0);
        if (reader) {
          try {
            void reader.cancel().catch(() => {});
          } catch {
            /* Cleanup never replaces a success or sanitized error. */
          }
          try {
            reader.releaseLock();
          } catch {
            /* A timed-out read may still be pending. */
          }
        } else if (response) cancel(response);
      }
    },
  };
}

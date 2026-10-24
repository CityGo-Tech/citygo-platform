// Server-only delivery preparation. Creating this adapter sends nothing and
// does not enable phone verification or bonus credit. The configured sender
// must be independently approved for the operator/template before live use.
const ENDPOINT = "https://sms.ru/sms/send";
const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PHONE = /^79[0-9]{9}$/;
const OTP = /^[0-9]{6}$/;
const MESSAGE_ID = /^[0-9]{1,20}-[0-9]{1,40}$/;

export type SmsRuMode = "test" | "live";
export type SmsRuDeliveryResult =
  | {
      provider: "sms_ru";
      mode: "test";
      accepted: false;
      simulated: true;
    }
  | {
      provider: "sms_ru";
      mode: "live";
      accepted: true;
      simulated: false;
      providerMessageId: string;
    };
export type SmsRuDeliveryInput = {
  // Already normalized Russian mobile MSISDN, without '+'. This adapter does
  // not reinterpret local numbers, lists, Kazakhstan +76/+77 or landlines.
  phone: string;
  code: string;
  signal: AbortSignal;
};
export type SmsRuDeliveryOptions = {
  mode: SmsRuMode;
  apiId: string;
  // No provider-default sender or user-supplied free-form message is allowed.
  from: string;
  fetch?: typeof globalThis.fetch;
};
export type SmsRuFailureCode =
  | "configuration"
  | "invalid_input"
  | "aborted"
  | "timeout"
  | "transport"
  | "http"
  | "invalid_response"
  | "rejected";

export class SmsRuDeliveryError extends Error {
  constructor(
    readonly code: SmsRuFailureCode,
    readonly outcome: "not_dispatched" | "unknown" | "rejected",
  ) {
    // Never include request URLs with parameters, phone, OTP, key, provider
    // body, status_text, an upstream exception or its cause in diagnostics.
    super("Не удалось отправить код подтверждения телефона.");
    this.name = "SmsRuDeliveryError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: object, keys: string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}
function configured(options: SmsRuDeliveryOptions) {
  return (
    object(options) &&
    Object.keys(options).every((key) =>
      ["mode", "apiId", "from", "fetch"].includes(key),
    ) &&
    (options.mode === "test" || options.mode === "live") &&
    typeof options.apiId === "string" &&
    /^[A-Za-z0-9_-]{16,128}$/.test(options.apiId) &&
    typeof options.from === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,10}$/.test(options.from) &&
    (options.fetch === undefined || typeof options.fetch === "function")
  );
}
function validInput(input: SmsRuDeliveryInput) {
  return (
    object(input) &&
    exactKeys(input, ["phone", "code", "signal"]) &&
    typeof input.phone === "string" &&
    PHONE.test(input.phone) &&
    typeof input.code === "string" &&
    OTP.test(input.code) &&
    input.signal instanceof AbortSignal
  );
}
function explicitRejection(value: Record<string, unknown>) {
  return (
    value.status === "ERROR" &&
    Number.isInteger(value.status_code) &&
    typeof value.status_code === "number" &&
    value.status_code >= 200 &&
    value.status_code < 400
  );
}
function message(code: string) {
  const value = `CityGo: код подтверждения номера ${code}. Никому не сообщайте.`;
  // ASCII + BMP Cyrillic only, under a single UCS-2 SMS segment. Do not add
  // marketing text, links, names, balances or any other user/profile data.
  if (value.length > 70)
    throw new SmsRuDeliveryError("configuration", "not_dispatched");
  return value;
}
function cancelBody(response: Response) {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Cancellation can race an already acquired reader. Its own cleanup also
    // cancels; neither branch waits forever for an abort-ignoring transport.
  }
}

export function createSmsRuDelivery(options: SmsRuDeliveryOptions) {
  if (!configured(options))
    throw new SmsRuDeliveryError("configuration", "not_dispatched");
  // Copy settings once: a later mutation of the caller's config cannot turn a
  // test adapter live or change its destination/credential between requests.
  const { mode, apiId, from } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    provider: "sms_ru" as const,
    mode,
    async send(input: SmsRuDeliveryInput): Promise<SmsRuDeliveryResult> {
      if (!validInput(input))
        throw new SmsRuDeliveryError("invalid_input", "not_dispatched");
      if (input.signal.aborted)
        throw new SmsRuDeliveryError("aborted", "not_dispatched");
      const body = new URLSearchParams({
        api_id: apiId,
        to: input.phone,
        msg: message(input.code),
        from,
        json: "1",
        ttl: "10",
        ...(mode === "test" ? { test: "1" } : {}),
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
      const check = () => {
        if (failure)
          throw new SmsRuDeliveryError(
            failure,
            dispatched ? "unknown" : "not_dispatched",
          );
      };
      async function wait<T>(pending: Promise<T>): Promise<T> {
        // Always consume both outcomes, including a fetch that synchronously
        // aborts its signal before returning a rejected promise.
        return new Promise<T>((resolve, reject) => {
          const done = () =>
            controller.signal.removeEventListener("abort", stopped);
          const stopped = () => {
            done();
            reject(
              new SmsRuDeliveryError(
                failure ?? "aborted",
                dispatched ? "unknown" : "not_dispatched",
              ),
            );
          };
          controller.signal.addEventListener("abort", stopped, { once: true });
          pending.then(
            (value) => {
              done();
              if (failure) stopped();
              else resolve(value);
            },
            () => {
              done();
              reject(
                new SmsRuDeliveryError(
                  failure ?? "transport",
                  dispatched ? "unknown" : "not_dispatched",
                ),
              );
            },
          );
          if (controller.signal.aborted) stopped();
        });
      }
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const chunks: Buffer[] = [];
      try {
        check();
        dispatched = true;
        const pending = fetch(ENDPOINT, {
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
          if (controller.signal.aborted) cancelBody(value);
          return value;
        });
        response = await wait(pending);
        check();
        if (response.redirected || (response.url && response.url !== ENDPOINT))
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        if (response.status !== 200)
          throw new SmsRuDeliveryError("http", "unknown");
        if (
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() !== "application/json" ||
          !response.body
        )
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^[0-9]{1,12}$/.test(declared) ||
            Number(declared) > MAX_RESPONSE_BYTES)
        )
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        reader = response.body.getReader();
        let size = 0;
        for (;;) {
          const item = await wait(reader.read());
          check();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > MAX_RESPONSE_BYTES)
            throw new SmsRuDeliveryError("invalid_response", "unknown");
          chunks.push(Buffer.from(item.value));
        }
        const raw = Buffer.concat(chunks);
        let value: unknown;
        try {
          value = JSON.parse(raw.toString("utf8"));
        } finally {
          raw.fill(0);
        }
        check();
        if (!object(value))
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        if (value.status !== "OK" || value.status_code !== 100)
          throw new SmsRuDeliveryError(
            explicitRejection(value) ? "rejected" : "invalid_response",
            explicitRejection(value) ? "rejected" : "unknown",
          );
        const records = value.sms;
        if (!object(records) || !exactKeys(records, [input.phone]))
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        const record = records[input.phone];
        if (!object(record))
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        if (record.status !== "OK" || record.status_code !== 100)
          throw new SmsRuDeliveryError(
            explicitRejection(record) ? "rejected" : "invalid_response",
            explicitRejection(record) ? "rejected" : "unknown",
          );
        if (
          typeof record.sms_id !== "string" ||
          !MESSAGE_ID.test(record.sms_id)
        )
          throw new SmsRuDeliveryError("invalid_response", "unknown");
        // No cost cap or delivery/ownership guarantee is inferred from an
        // accepted ID/balance. Most importantly, simulation NEVER has the live
        // accepted:true shape a future phone-confirmation gate might require.
        return mode === "test"
          ? {
              provider: "sms_ru",
              mode: "test",
              accepted: false,
              simulated: true,
            }
          : {
              provider: "sms_ru",
              mode: "live",
              accepted: true,
              simulated: false,
              providerMessageId: record.sms_id,
            };
      } catch (error) {
        if (error instanceof SmsRuDeliveryError) throw error;
        throw new SmsRuDeliveryError(
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
            /* Ignore cleanup races, never upstream details. */
          }
          try {
            reader.releaseLock();
          } catch {
            /* A timed-out read may still be pending. */
          }
        } else if (response) cancelBody(response);
      }
    },
  };
}

// Server-only transport. The caller explicitly chooses the shop mode; neither
// the credentials nor a provider response can change it. A create response is
// never proof authorizing balance credit: settlement requires a separate GET.
import { isDeepStrictEqual } from "node:util";
import {
  assertYooKassaReceiptTotal,
  yooKassaReceiptRegistrationSchema,
  type YooKassaReceipt,
  type YooKassaReceiptRegistration,
} from "@citygo/contracts";
const ENDPOINT = "https://api.yookassa.ru/v3";
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const PROVIDER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ORDER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT = /^(0|[1-9][0-9]{0,7})\.([0-9]{2})$/;

export type YooKassaMode = "test" | "live";
export type YooKassaPayment = {
  id: string;
  orderId: string;
  merchantId: string;
  amountKopeks: number;
  currency: "RUB";
  test: boolean;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  confirmationUrl?: string;
  verifiedAt: string;
  receiptRegistration?: YooKassaReceiptRegistration;
};
export type YooKassaTestPayment = YooKassaPayment & { test: true };

export type YooKassaClientOptions = {
  mode: YooKassaMode;
  shopId: string;
  secretKey: string;
  fetch?: typeof globalThis.fetch;
};

// Prefix checks are an additional CityGo safety policy, not proof of merchant
// ownership. Every payment observation also checks account_id and exact mode.
export function validYooKassaCredentials(
  options: Pick<YooKassaClientOptions, "mode" | "shopId" | "secretKey">,
) {
  return (
    (options.mode === "test" || options.mode === "live") &&
    typeof options.shopId === "string" &&
    typeof options.secretKey === "string" &&
    /^[1-9][0-9]{0,19}$/.test(options.shopId) &&
    (options.mode === "test"
      ? /^test_[A-Za-z0-9_=-]{8,8192}$/
      : /^live_[A-Za-z0-9_=-]{8,8192}$/
    ).test(options.secretKey)
  );
}

type YooKassaFailureClass =
  | "configuration"
  | "invalid_input"
  | "transport"
  | "timeout"
  | "http"
  | "invalid_response";
const PROVIDER_ERROR_CODES = [
  "invalid_request",
  "invalid_credentials",
  "forbidden",
  "not_found",
  "too_many_requests",
  "internal_server_error",
] as const;
const PROVIDER_ERROR_PARAMETERS = [
  "receipt",
  "receipt.customer",
  "receipt.customer.email",
  "receipt.items",
  "amount",
  "amount.value",
  "amount.currency",
  "confirmation",
  "confirmation.type",
  "confirmation.return_url",
  "capture",
  "description",
  "metadata",
  "payment_method_data",
  "Idempotence-Key",
] as const;
const FAILURE_CLASSES = [
  "configuration",
  "invalid_input",
  "transport",
  "timeout",
  "http",
  "invalid_response",
] as const;
export type YooKassaFailureDiagnostic = Readonly<{
  failureClass: YooKassaFailureClass;
  httpStatus: number | null;
  providerCode: (typeof PROVIDER_ERROR_CODES)[number] | "unrecognized" | null;
  parameter: (typeof PROVIDER_ERROR_PARAMETERS)[number] | "unrecognized" | null;
}>;
const failureDiagnostics = new WeakMap<object, YooKassaFailureDiagnostic>();
function literal<T extends string>(value: unknown, allowed: readonly T[]) {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : "unrecognized";
}

export class YooKassaError extends Error {
  constructor(
    readonly code: YooKassaFailureClass,
    diagnostic?: {
      httpStatus?: number;
      providerCode?: unknown;
      parameter?: unknown;
    },
  ) {
    super(
      "Не удалось выполнить операцию ЮKassa. Проверьте состояние перед повтором.",
    );
    this.name = "YooKassaError";
    // Nothing from the provider is attached to the error. Even JSON.stringify,
    // error serializers and later property mutation cannot reveal a raw body,
    // description, headers, identifier, URL or credential through this record.
    const failureClass = literal(code, FAILURE_CLASSES);
    failureDiagnostics.set(
      this,
      Object.freeze({
        failureClass:
          failureClass === "unrecognized" ? "invalid_response" : failureClass,
        httpStatus:
          Number.isInteger(diagnostic?.httpStatus) &&
          diagnostic!.httpStatus! >= 100 &&
          diagnostic!.httpStatus! <= 599
            ? diagnostic!.httpStatus!
            : null,
        providerCode:
          diagnostic?.providerCode === undefined
            ? null
            : literal(diagnostic.providerCode, PROVIDER_ERROR_CODES),
        parameter:
          diagnostic?.parameter === undefined
            ? null
            : literal(diagnostic.parameter, PROVIDER_ERROR_PARAMETERS),
      }),
    );
  }
}
// Return only the immutable projection created by this module, never fields
// supplied on an arbitrary Error or even on a lookalike subclass/prototype.
export function yooKassaFailureDiagnostic(
  error: unknown,
): YooKassaFailureDiagnostic | undefined {
  return typeof error === "object" && error !== null
    ? failureDiagnostics.get(error)
    : undefined;
}
// Kept as the same constructor so existing sandbox error handling remains valid.
export { YooKassaError as YooKassaTestError };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 1_000_000_000
  );
}
function httpsUrl(value: unknown, confirmation = false): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return;
    // Official redirect integration examples use this exact payment-page host.
    // Do not permit suffix matches, arbitrary provider URLs or custom schemes.
    if (confirmation && url.hostname !== "yoomoney.ru") return;
    return url.href;
  } catch {
    return;
  }
}
function cancel(response: Response | undefined) {
  void response?.body?.cancel().catch(() => {});
}

export class YooKassaClient {
  #authorization: string;
  #shopId: string;
  #fetch: typeof globalThis.fetch;
  #mode: YooKassaMode;

  constructor(options: YooKassaClientOptions) {
    if (!validYooKassaCredentials(options))
      throw new YooKassaError("configuration");
    this.#mode = options.mode;
    this.#shopId = options.shopId;
    this.#authorization =
      "Basic " +
      Buffer.from(options.shopId + ":" + options.secretKey, "utf8").toString(
        "base64",
      );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async create(input: {
    orderId: string;
    amountKopeks: number;
    returnUrl: string;
    receipt?: YooKassaReceipt;
    createPayload?: unknown;
  }): Promise<YooKassaPayment> {
    input = Object.freeze({ ...input });
    this.validateExpected(input);
    const returnUrl = httpsUrl(input.returnUrl);
    if (!returnUrl) throw new YooKassaError("invalid_input");
    const amount = BigInt(input.amountKopeks);
    let receipt: YooKassaReceipt | undefined;
    try {
      if (input.receipt !== undefined)
        receipt = assertYooKassaReceiptTotal(input.receipt, input.amountKopeks);
    } catch {
      throw new YooKassaError("invalid_input");
    }
    const body = {
      amount: {
        value: `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`,
        currency: "RUB",
      },
      capture: true,
      confirmation: { type: "redirect", return_url: returnUrl },
      description:
        this.#mode === "test"
          ? "Пополнение тестового баланса CityGo"
          : "Пополнение баланса CityGo",
      metadata: { citygo_order_id: input.orderId },
      ...(receipt ? { receipt } : {}),
    };
    if (receipt && receipt.items[0]!.description !== body.description)
      throw new YooKassaError("invalid_input");
    if (
      input.createPayload !== undefined &&
      !isDeepStrictEqual(input.createPayload, body)
    )
      throw new YooKassaError("invalid_input");
    return this.request("POST", "/payments", input, body);
  }

  async get(
    paymentId: string,
    expected: { orderId: string; amountKopeks: number },
  ): Promise<YooKassaPayment> {
    expected = Object.freeze({ ...expected });
    this.validateExpected(expected);
    if (typeof paymentId !== "string" || !PROVIDER_ID.test(paymentId))
      throw new YooKassaError("invalid_input");
    return this.request(
      "GET",
      "/payments/" + encodeURIComponent(paymentId),
      expected,
      undefined,
      paymentId,
    );
  }

  private validateExpected(input: { orderId: string; amountKopeks: number }) {
    if (
      typeof input.orderId !== "string" ||
      !ORDER_ID.test(input.orderId) ||
      !validAmount(input.amountKopeks)
    )
      throw new YooKassaError("invalid_input");
  }

  private parse(
    raw: unknown,
    expected: { orderId: string; amountKopeks: number },
    paymentId?: string,
  ): YooKassaPayment {
    const invalid = () => new YooKassaError("invalid_response");
    if (
      !object(raw) ||
      typeof raw.id !== "string" ||
      !PROVIDER_ID.test(raw.id) ||
      (paymentId !== undefined && raw.id !== paymentId) ||
      !object(raw.recipient) ||
      raw.recipient.account_id !== this.#shopId ||
      !object(raw.metadata) ||
      raw.metadata.citygo_order_id !== expected.orderId ||
      raw.test !== (this.#mode === "test") ||
      !object(raw.amount) ||
      raw.amount.currency !== "RUB" ||
      typeof raw.amount.value !== "string" ||
      typeof raw.paid !== "boolean"
    )
      throw invalid();
    const amount = AMOUNT.exec(raw.amount.value);
    if (
      !amount ||
      BigInt(amount[1]!) * 100n + BigInt(amount[2]!) !==
        BigInt(expected.amountKopeks)
    )
      throw invalid();
    const status = raw.status;
    if (
      status !== "pending" &&
      status !== "waiting_for_capture" &&
      status !== "succeeded" &&
      status !== "canceled"
    )
      throw invalid();
    if (
      raw.paid !== (status === "succeeded" || status === "waiting_for_capture")
    )
      throw invalid();
    // Refund accounting is outside this payment transport. Never let an
    // already refunded payment masquerade as a fresh successful top-up.
    if (
      raw.refunded_amount !== undefined &&
      (!object(raw.refunded_amount) ||
        raw.refunded_amount.currency !== "RUB" ||
        raw.refunded_amount.value !== "0.00")
    )
      throw invalid();
    let confirmationUrl: string | undefined;
    const receiptRegistration =
      raw.receipt_registration === undefined
        ? undefined
        : yooKassaReceiptRegistrationSchema.safeParse(raw.receipt_registration);
    if (receiptRegistration && !receiptRegistration.success) throw invalid();
    if (raw.confirmation !== undefined) {
      if (
        !object(raw.confirmation) ||
        raw.confirmation.type !== "redirect" ||
        !(confirmationUrl = httpsUrl(raw.confirmation.confirmation_url, true))
      )
        throw invalid();
    }
    return {
      id: raw.id,
      orderId: expected.orderId,
      merchantId: this.#shopId,
      amountKopeks: expected.amountKopeks,
      currency: "RUB",
      test: this.#mode === "test",
      status,
      paid: raw.paid,
      ...(confirmationUrl ? { confirmationUrl } : {}),
      verifiedAt: new Date().toISOString(),
      ...(receiptRegistration?.success
        ? { receiptRegistration: receiptRegistration.data }
        : {}),
    };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    expected: { orderId: string; amountKopeks: number },
    body?: unknown,
    paymentId?: string,
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    let responseStatus: number | undefined;
    let httpFailure = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new YooKassaError("timeout"));
      }, TIMEOUT_MS);
    });
    const wait = <T>(pending: Promise<T>) => Promise.race([pending, deadline]);
    try {
      const url = ENDPOINT + path;
      const pending = this.#fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: this.#authorization,
          ...(method === "POST"
            ? {
                "Content-Type": "application/json",
                "Idempotence-Key": expected.orderId,
              }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      }).then((result) => {
        if (controller.signal.aborted) cancel(result);
        return result;
      });
      response = await wait(pending);
      responseStatus = response.status;
      httpFailure = !response.ok;
      if (response.redirected || (response.url && response.url !== url))
        throw new YooKassaError("invalid_response");
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json" ||
        !response.body
      )
        throw new YooKassaError("invalid_response");
      const length = response.headers.get("content-length");
      if (
        length &&
        /^\d+$/.test(length) &&
        BigInt(length) > BigInt(MAX_RESPONSE_BYTES)
      )
        throw new YooKassaError("invalid_response");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      while (true) {
        const result = await wait(reader.read());
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES)
          throw new YooKassaError("invalid_response");
        text += decoder.decode(result.value, { stream: true });
      }
      text += decoder.decode();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new YooKassaError("invalid_response");
      }
      if (httpFailure)
        throw new YooKassaError("http", {
          httpStatus: responseStatus,
          providerCode: object(raw) ? raw.code : undefined,
          parameter: object(raw) ? raw.parameter : undefined,
        });
      return this.parse(raw, expected, paymentId);
    } catch (error) {
      if (error instanceof YooKassaError && error.code === "http") throw error;
      const code =
        error instanceof YooKassaError
          ? error.code
          : controller.signal.aborted
            ? "timeout"
            : "transport";
      // Non-JSON/malformed/oversized HTTP errors still retain the status but
      // never the response text. The same deadline also bounds error bodies.
      throw new YooKassaError(
        httpFailure && code !== "timeout" ? "http" : code,
        {
          httpStatus: responseStatus,
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      } else cancel(response);
    }
  }
}

// Sandbox callers cannot opt into live behavior through an accidental extra
// property: the fixed mode is applied last and cannot change after construction.
export class YooKassaTestClient extends YooKassaClient {
  constructor(options: Omit<YooKassaClientOptions, "mode">) {
    super({ ...options, mode: "test" });
  }

  override create(input: {
    orderId: string;
    amountKopeks: number;
    returnUrl: string;
    receipt?: YooKassaReceipt;
    createPayload?: unknown;
  }): Promise<YooKassaTestPayment> {
    return super.create(input) as Promise<YooKassaTestPayment>;
  }

  override get(
    paymentId: string,
    expected: { orderId: string; amountKopeks: number },
  ): Promise<YooKassaTestPayment> {
    return super.get(paymentId, expected) as Promise<YooKassaTestPayment>;
  }
}

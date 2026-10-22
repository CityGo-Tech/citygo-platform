// Server-only mode-bound transport, not a refund endpoint or ledger primitive.
// The caller must persist this identity/payload and reserve refundable paid
// funds before calling. This module neither reserves nor finalizes any balance.
// API schema: https://yookassa.ru/developers/api/yookassa-openapi-specification.yaml
import { isDeepStrictEqual } from "node:util";
import {
  validYooKassaCredentials,
  type YooKassaClientOptions,
  type YooKassaMode,
} from "./yookassa.js";
const ENDPOINT = "https://api.yookassa.ru/v3";
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const REPLAY_LIMIT_MS = 23 * 60 * 60 * 1000;
const PROVIDER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT = /^(0|[1-9][0-9]{0,7})\.([0-9]{2})$/;

export type YooKassaRefundInput = {
  refundRequestId: string;
  paymentId: string;
  orderId: string;
  paymentAmountKopeks: number;
  amountKopeks: number;
  // Immutable observation accepted when the refund reservation was created.
  refundedBeforeKopeks: number;
  createdAt: string;
  // Runtime journal supplies the exact immutable POST body. Older standalone
  // transport fixtures may omit it; runtime endpoints never construct it here.
  createPayload?: unknown;
};
export type YooKassaTestRefundInput = YooKassaRefundInput;

export type YooKassaRefund = {
  id: string;
  refundRequestId: string;
  paymentId: string;
  orderId: string;
  merchantId: string;
  amountKopeks: number;
  currency: "RUB";
  // Derived from an authenticated GET of the original payment, not from
  // nonexistent refund.test or refund.recipient fields.
  test: boolean;
  refundedAmountKopeks: number;
  status: "pending" | "succeeded" | "canceled";
  observation: "create_response" | "server_get";
  verifiedAt: string;
};
export type YooKassaTestRefund = YooKassaRefund & { test: true };

type ErrorCode =
  | "configuration"
  | "invalid_input"
  | "payment_mismatch"
  | "invalid_response"
  | "transport"
  | "timeout"
  | "http";

export class YooKassaTestRefundError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly outcome:
      "not_sent" | "unknown" | "observation_failed" = "not_sent",
  ) {
    super(
      "Возврат требует проверки состояния. Ошибка не доказывает отмену возврата и не разрешает освобождать резерв.",
    );
    this.name = "YooKassaTestRefundError";
  }
}
export { YooKassaTestRefundError as YooKassaRefundError };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validKopeks(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 1_000_000_000
  );
}
function kopeks(raw: unknown): number | undefined {
  if (!object(raw) || raw.currency !== "RUB" || typeof raw.value !== "string")
    return;
  const match = AMOUNT.exec(raw.value);
  if (!match) return;
  const value = BigInt(match[1]!) * 100n + BigInt(match[2]!);
  if (value > 1_000_000_000n) return;
  return Number(value);
}
function cancel(response: Response | undefined) {
  void response?.body?.cancel().catch(() => {});
}

type Request = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotenceKey?: string,
) => Promise<unknown>;

export class YooKassaRefundClient {
  #authorization: string;
  #shopId: string;
  #fetch: typeof globalThis.fetch;
  #mode: YooKassaMode;

  constructor(options: YooKassaClientOptions) {
    if (!validYooKassaCredentials(options))
      throw new YooKassaTestRefundError("configuration");
    this.#mode = options.mode;
    this.#shopId = options.shopId;
    this.#authorization =
      "Basic " +
      Buffer.from(options.shopId + ":" + options.secretKey, "utf8").toString(
        "base64",
      );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async createRefund(input: YooKassaRefundInput): Promise<YooKassaRefund> {
    input = Object.freeze({ ...input });
    this.validate(input);
    this.createWindow(input);
    const amount = BigInt(input.amountKopeks);
    const body = {
      payment_id: input.paymentId,
      amount: {
        value: `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`,
        currency: "RUB",
      },
      description:
        this.#mode === "test"
          ? "Тестовый возврат CityGo"
          : "Возврат средств CityGo",
      metadata: { citygo_refund_id: input.refundRequestId },
    };
    if (
      input.createPayload !== undefined &&
      !isDeepStrictEqual(input.createPayload, body)
    )
      throw new YooKassaTestRefundError("invalid_input");
    return this.operation(false, async (request) => {
      const refunded = this.payment(
        await request("GET", "/payments/" + input.paymentId),
        input,
        true,
      );
      // An ambiguous earlier POST or an out-of-band refund needs reconciliation,
      // not another monetary request using a newly observed balance.
      if (refunded !== input.refundedBeforeKopeks)
        throw new YooKassaTestRefundError("payment_mismatch");
      this.createWindow(input);
      const raw = await request(
        "POST",
        "/refunds",
        body,
        input.refundRequestId,
      );
      // Even status=succeeded here is only a create observation, never a ledger
      // instruction. The caller must save the ID and perform a separate GET.
      return this.refund(raw, input, refunded, "create_response");
    });
  }

  async getRefund(
    refundId: string,
    input: YooKassaRefundInput,
  ): Promise<YooKassaRefund> {
    input = Object.freeze({ ...input });
    this.validate(input);
    if (typeof refundId !== "string" || !PROVIDER_ID.test(refundId))
      throw new YooKassaTestRefundError("invalid_input");
    return this.operation(true, async (request) => {
      const raw = await request("GET", "/refunds/" + refundId);
      // Refund objects have neither recipient nor test. Bind the saved refund
      // to a freshly authenticated payment from this exact shop and mode.
      const refunded = this.payment(
        await request("GET", "/payments/" + input.paymentId),
        input,
        false,
      );
      const result = this.refund(raw, input, refunded, "server_get", refundId);
      if (
        refunded < input.refundedBeforeKopeks ||
        (result.status === "succeeded" &&
          refunded < input.refundedBeforeKopeks + input.amountKopeks)
      )
        throw new YooKassaTestRefundError("payment_mismatch");
      return result;
    });
  }

  private createWindow(input: YooKassaRefundInput) {
    const age = Date.now() - Date.parse(input.createdAt);
    if (age < -60_000 || age >= REPLAY_LIMIT_MS)
      throw new YooKassaTestRefundError("invalid_input");
  }

  private validate(input: YooKassaRefundInput) {
    if (
      !input ||
      typeof input.refundRequestId !== "string" ||
      !REQUEST_ID.test(input.refundRequestId) ||
      typeof input.orderId !== "string" ||
      !REQUEST_ID.test(input.orderId) ||
      typeof input.paymentId !== "string" ||
      !PROVIDER_ID.test(input.paymentId) ||
      !validKopeks(input.paymentAmountKopeks, 100) ||
      !validKopeks(input.amountKopeks, 100) ||
      !validKopeks(input.refundedBeforeKopeks, 0) ||
      input.amountKopeks + input.refundedBeforeKopeks >
        input.paymentAmountKopeks ||
      (input.paymentAmountKopeks -
        input.refundedBeforeKopeks -
        input.amountKopeks >
        0 &&
        input.paymentAmountKopeks -
          input.refundedBeforeKopeks -
          input.amountKopeks <
          100) ||
      typeof input.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        input.createdAt,
      ) ||
      !Number.isFinite(Date.parse(input.createdAt))
    )
      throw new YooKassaTestRefundError("invalid_input");
  }

  private payment(raw: unknown, input: YooKassaRefundInput, creating: boolean) {
    if (
      !object(raw) ||
      raw.id !== input.paymentId ||
      raw.status !== "succeeded" ||
      raw.paid !== true ||
      raw.test !== (this.#mode === "test") ||
      !object(raw.recipient) ||
      raw.recipient.account_id !== this.#shopId ||
      !object(raw.metadata) ||
      raw.metadata.citygo_order_id !== input.orderId ||
      kopeks(raw.amount) !== input.paymentAmountKopeks ||
      (creating && raw.refundable !== true)
    )
      throw new YooKassaTestRefundError("payment_mismatch");
    const refunded = kopeks(raw.refunded_amount);
    if (
      refunded === undefined ||
      refunded > input.paymentAmountKopeks ||
      (creating && refunded + input.amountKopeks > input.paymentAmountKopeks)
    )
      throw new YooKassaTestRefundError("payment_mismatch");
    return refunded;
  }

  private refund(
    raw: unknown,
    input: YooKassaRefundInput,
    refundedAmountKopeks: number,
    observation: YooKassaRefund["observation"],
    refundId?: string,
  ): YooKassaRefund {
    if (
      !object(raw) ||
      typeof raw.id !== "string" ||
      !PROVIDER_ID.test(raw.id) ||
      (refundId !== undefined && raw.id !== refundId) ||
      raw.payment_id !== input.paymentId ||
      !object(raw.metadata) ||
      raw.metadata.citygo_refund_id !== input.refundRequestId ||
      kopeks(raw.amount) !== input.amountKopeks ||
      (raw.status !== "pending" &&
        raw.status !== "succeeded" &&
        raw.status !== "canceled")
    )
      throw new YooKassaTestRefundError("invalid_response");
    return {
      id: raw.id,
      refundRequestId: input.refundRequestId,
      paymentId: input.paymentId,
      orderId: input.orderId,
      merchantId: this.#shopId,
      amountKopeks: input.amountKopeks,
      currency: "RUB",
      test: this.#mode === "test",
      refundedAmountKopeks,
      status: raw.status,
      observation,
      verifiedAt: new Date().toISOString(),
    };
  }

  private async operation<T>(
    observation: boolean,
    work: (request: Request) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let mutationEntered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new YooKassaTestRefundError("timeout"));
      }, TIMEOUT_MS);
    });
    const wait = <V>(pending: Promise<V>) => Promise.race([pending, deadline]);
    const request: Request = async (method, path, body, idempotenceKey) => {
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const url = ENDPOINT + path;
        if (method === "POST") mutationEntered = true;
        response = await wait<Response>(
          this.#fetch(url, {
            method,
            headers: {
              Accept: "application/json",
              Authorization: this.#authorization,
              ...(method === "POST"
                ? {
                    "Content-Type": "application/json",
                    "Idempotence-Key": idempotenceKey!,
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
          }),
        );
        if (response.redirected || (response.url && response.url !== url))
          throw new YooKassaTestRefundError("invalid_response");
        if (!response.ok) throw new YooKassaTestRefundError("http");
        if (
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() !== "application/json" ||
          !response.body
        )
          throw new YooKassaTestRefundError("invalid_response");
        const length = response.headers.get("content-length");
        if (
          length &&
          /^\d+$/.test(length) &&
          BigInt(length) > BigInt(MAX_RESPONSE_BYTES)
        )
          throw new YooKassaTestRefundError("invalid_response");
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "",
          bytes = 0;
        while (true) {
          const chunk = await wait(reader.read());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES)
            throw new YooKassaTestRefundError("invalid_response");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new YooKassaTestRefundError("invalid_response");
        }
      } finally {
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        } else cancel(response);
      }
    };
    try {
      return await work(request);
    } catch (error) {
      throw new YooKassaTestRefundError(
        error instanceof YooKassaTestRefundError
          ? error.code
          : controller.signal.aborted
            ? "timeout"
            : "transport",
        mutationEntered
          ? "unknown"
          : observation
            ? "observation_failed"
            : "not_sent",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class YooKassaTestRefundClient extends YooKassaRefundClient {
  constructor(options: Omit<YooKassaClientOptions, "mode">) {
    super({ ...options, mode: "test" });
  }

  override createRefund(
    input: YooKassaRefundInput,
  ): Promise<YooKassaTestRefund> {
    return super.createRefund(input) as Promise<YooKassaTestRefund>;
  }

  override getRefund(
    refundId: string,
    input: YooKassaRefundInput,
  ): Promise<YooKassaTestRefund> {
    return super.getRefund(refundId, input) as Promise<YooKassaTestRefund>;
  }
}

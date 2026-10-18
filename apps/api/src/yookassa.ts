// Test-shop boundary only. No API route, environment activation or live key is
// accepted here. A create response is never proof authorizing balance credit.
const ENDPOINT = "https://api.yookassa.ru/v3";
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const PROVIDER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ORDER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT = /^(0|[1-9][0-9]{0,7})\.([0-9]{2})$/;

export type YooKassaTestPayment = {
  id: string;
  orderId: string;
  merchantId: string;
  amountKopeks: number;
  currency: "RUB";
  test: true;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  confirmationUrl?: string;
  verifiedAt: string;
};

export class YooKassaTestError extends Error {
  constructor(
    readonly code:
      | "configuration"
      | "invalid_input"
      | "transport"
      | "timeout"
      | "http"
      | "invalid_response",
  ) {
    super(
      "Не удалось выполнить тестовую операцию ЮKassa. Проверьте состояние перед повтором.",
    );
    this.name = "YooKassaTestError";
  }
}

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

export class YooKassaTestClient {
  #authorization: string;
  #shopId: string;
  #fetch: typeof globalThis.fetch;

  constructor(options: {
    shopId: string;
    secretKey: string;
    fetch?: typeof globalThis.fetch;
  }) {
    if (
      !/^[0-9]{1,100}$/.test(options.shopId) ||
      !/^test_[^\s:]{1,200}$/.test(options.secretKey)
    )
      throw new YooKassaTestError("configuration");
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
  }): Promise<YooKassaTestPayment> {
    this.validateExpected(input);
    const returnUrl = httpsUrl(input.returnUrl);
    if (!returnUrl) throw new YooKassaTestError("invalid_input");
    const amount = BigInt(input.amountKopeks);
    return this.request("POST", "/payments", input, {
      amount: {
        value: `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`,
        currency: "RUB",
      },
      capture: true,
      confirmation: { type: "redirect", return_url: returnUrl },
      description: "Пополнение тестового баланса CityGo",
      metadata: { citygo_order_id: input.orderId },
    });
  }

  async get(
    paymentId: string,
    expected: { orderId: string; amountKopeks: number },
  ): Promise<YooKassaTestPayment> {
    this.validateExpected(expected);
    if (typeof paymentId !== "string" || !PROVIDER_ID.test(paymentId))
      throw new YooKassaTestError("invalid_input");
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
      throw new YooKassaTestError("invalid_input");
  }

  private parse(
    raw: unknown,
    expected: { orderId: string; amountKopeks: number },
    paymentId?: string,
  ): YooKassaTestPayment {
    const invalid = () => new YooKassaTestError("invalid_response");
    if (
      !object(raw) ||
      typeof raw.id !== "string" ||
      !PROVIDER_ID.test(raw.id) ||
      (paymentId !== undefined && raw.id !== paymentId) ||
      !object(raw.recipient) ||
      raw.recipient.account_id !== this.#shopId ||
      !object(raw.metadata) ||
      raw.metadata.citygo_order_id !== expected.orderId ||
      raw.test !== true ||
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
    // Refund accounting is outside this test-only boundary. Never let an
    // already refunded payment masquerade as a fresh successful top-up.
    if (
      raw.refunded_amount !== undefined &&
      (!object(raw.refunded_amount) ||
        raw.refunded_amount.currency !== "RUB" ||
        raw.refunded_amount.value !== "0.00")
    )
      throw invalid();
    let confirmationUrl: string | undefined;
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
      test: true,
      status,
      paid: raw.paid,
      ...(confirmationUrl ? { confirmationUrl } : {}),
      verifiedAt: new Date().toISOString(),
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
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new YooKassaTestError("timeout"));
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
      if (response.redirected || (response.url && response.url !== url))
        throw new YooKassaTestError("invalid_response");
      if (!response.ok) throw new YooKassaTestError("http");
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json" ||
        !response.body
      )
        throw new YooKassaTestError("invalid_response");
      const length = response.headers.get("content-length");
      if (
        length &&
        /^\d+$/.test(length) &&
        BigInt(length) > BigInt(MAX_RESPONSE_BYTES)
      )
        throw new YooKassaTestError("invalid_response");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      while (true) {
        const result = await wait(reader.read());
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES)
          throw new YooKassaTestError("invalid_response");
        text += decoder.decode(result.value, { stream: true });
      }
      text += decoder.decode();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new YooKassaTestError("invalid_response");
      }
      return this.parse(raw, expected, paymentId);
    } catch (error) {
      if (error instanceof YooKassaTestError) throw error;
      throw new YooKassaTestError(
        controller.signal.aborted ? "timeout" : "transport",
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

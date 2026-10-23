import { z } from "zod";
import { isAsciiSenderEmail } from "@citygo/config";
import { signAwsV4 } from "./signing.js";

// Explicit static service-account credentials only; no ambient AWS credentials.
// https://yandex.cloud/ru/docs/postbox/api-ref/authentication
// https://yandex.cloud/ru/docs/postbox/aws-compatible-api/signing-requests
const ENDPOINT = "https://postbox.cloud.yandex.net/v2/email/outbound-emails";
const HOST = "postbox.cloud.yandex.net";
const PATH = "/v2/email/outbound-emails";
const MAX_RESPONSE_BYTES = 64 * 1024;
const emailSchema = z.string().max(254).email();

export type PostboxAcceptedReceipt = {
  accepted: true;
  provider: "yandex_postbox";
  messageId: string;
};

export type PostboxDeliveryInput = {
  email: string;
  code: string;
  expiresAt: string;
  signal: AbortSignal;
};

export type PostboxDeliveryConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  /** One verified bare sender address; never obtained from a user's request. */
  fromEmail: string;
  timeoutMs?: number;
};

type ErrorCode =
  | "configuration"
  | "input"
  | "aborted"
  | "timeout"
  | "transport"
  | "http"
  | "invalid_response";

export class PostboxDeliveryError extends Error {
  constructor(readonly code: ErrorCode) {
    // Never attach upstream errors, URLs, recipient, OTP, headers or response body.
    super("Email delivery could not be confirmed.");
    this.name = "PostboxDeliveryError";
  }
}

function email(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\x21-\x7e]+$/.test(value) &&
    emailSchema.safeParse(value).success
  );
}

function cancel(response: Response | undefined) {
  try {
    void response?.body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup must not expose transport details or replace the sanitized error.
  }
}

/** Construction does not send mail. Transport/clock injection is per instance. */
export function createPostboxDelivery(
  config: PostboxDeliveryConfig,
  options: { fetch?: typeof globalThis.fetch; clock?: () => Date } = {},
): (input: PostboxDeliveryInput) => Promise<PostboxAcceptedReceipt> {
  const timeoutMs = config.timeoutMs ?? 5_000;
  if (
    typeof config.accessKeyId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(config.accessKeyId) ||
    typeof config.secretAccessKey !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(config.secretAccessKey) ||
    !isAsciiSenderEmail(config.fromEmail) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 7_500
  ) {
    throw new PostboxDeliveryError("configuration");
  }
  // Snapshot caller-owned config so later mutations cannot change the sender.
  const { accessKeyId, secretAccessKey, fromEmail } = config;
  const fetcher = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? (() => new Date());

  return async (input) => {
    if (input.signal.aborted) throw new PostboxDeliveryError("aborted");
    let now: Date;
    try {
      now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        throw new Error();
    } catch {
      throw new PostboxDeliveryError("configuration");
    }
    if (
      !email(input.email) ||
      typeof input.code !== "string" ||
      !/^[0-9]{6}$/.test(input.code) ||
      typeof input.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        input.expiresAt,
      )
    ) {
      throw new PostboxDeliveryError("input");
    }
    const expires = new Date(input.expiresAt);
    if (
      !Number.isFinite(expires.getTime()) ||
      expires.toISOString() !==
        input.expiresAt.replace(/:([0-9]{2})Z$/, ":$1.000Z") ||
      expires.getTime() <= now.getTime()
    ) {
      throw new PostboxDeliveryError("input");
    }
    // SendEmail Simple.Text only: no tracking pixels, extra recipients, metadata,
    // reply address, attachments, or AI context. A MessageId means accepted,
    // not delivery to the mailbox and not proof of control of that mailbox.
    // https://yandex.cloud/ru/docs/postbox/aws-compatible-api/api-ref/send-email
    const body = JSON.stringify({
      FromEmailAddress: fromEmail,
      Destination: { ToAddresses: [input.email] },
      Content: {
        Simple: {
          Subject: { Data: "Код подтверждения CityGo", Charset: "UTF-8" },
          Body: {
            Text: {
              Data: `Код подтверждения CityGo: ${input.code}\nДействителен до ${expires.toISOString()} (UTC).\nЕсли вы не регистрировались в CityGo, проигнорируйте письмо. Никому не сообщайте код.`,
              Charset: "UTF-8",
            },
          },
        },
      },
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      host: HOST,
      "x-amz-date": now.toISOString().replace(/[:-]|\.\d{3}/g, ""),
    };
    try {
      headers.authorization = signAwsV4({
        method: "POST",
        path: PATH,
        headers,
        body,
        region: "ru-central1",
        service: "ses",
        accessKeyId,
        secretAccessKey,
      });
    } catch {
      throw new PostboxDeliveryError("configuration");
    }

    const controller = new AbortController();
    let failure: PostboxDeliveryError | undefined;
    let rejectDeadline!: (error: PostboxDeliveryError) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    // A custom transport may abort and throw synchronously before wait() runs.
    // Keep that deadline rejection observed while preserving the race below.
    void deadline.catch(() => undefined);
    const stop = (code: "aborted" | "timeout") => {
      if (failure) return;
      failure = new PostboxDeliveryError(code);
      controller.abort();
      rejectDeadline(failure);
    };
    const abort = () => stop("aborted");
    input.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const wait = <T>(pending: Promise<T>) => Promise.race([pending, deadline]);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (input.signal.aborted) throw new PostboxDeliveryError("aborted");
      const pending = fetcher(ENDPOINT, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      }).then((result) => {
        if (controller.signal.aborted) cancel(result);
        return result;
      });
      response = await wait(pending);
      if (response.redirected || (response.url && response.url !== ENDPOINT))
        throw new PostboxDeliveryError("invalid_response");
      // No retry: even a timeout could have accepted the email upstream.
      if (response.status !== 200) throw new PostboxDeliveryError("http");
      // SendEmail specifies HTTP 200 + a JSON MessageId, not a response MIME.
      // A controlled Postbox request returned 200 with a different MIME; do not
      // confuse that metadata with rejection. Never render or execute the body:
      // retain the byte/deadline/UTF-8/JSON/MessageId checks below for every MIME.
      if (!response.body) throw new PostboxDeliveryError("invalid_response");
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/.test(length) || BigInt(length) > BigInt(MAX_RESPONSE_BYTES))
      )
        throw new PostboxDeliveryError("invalid_response");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let text = "",
        bytes = 0;
      while (true) {
        const part = await wait(reader.read());
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES)
          throw new PostboxDeliveryError("invalid_response");
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let result: unknown;
      try {
        result = JSON.parse(text);
      } catch {
        throw new PostboxDeliveryError("invalid_response");
      }
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !("MessageId" in result) ||
        typeof result.MessageId !== "string" ||
        !/^[\x21-\x7e]{1,512}$/.test(result.MessageId)
      )
        throw new PostboxDeliveryError("invalid_response");
      return {
        accepted: true,
        provider: "yandex_postbox",
        messageId: result.MessageId,
      };
    } catch (error) {
      if (failure) throw failure;
      if (error instanceof PostboxDeliveryError) throw error;
      throw new PostboxDeliveryError("transport");
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      if (reader) {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // Best-effort cleanup must not replace an acknowledgement or the
          // original sanitized failure with an upstream exception.
        }
        try {
          reader.releaseLock();
        } catch {
          // The same rule applies if a transport cannot release its reader.
        }
      } else cancel(response);
    }
  };
}

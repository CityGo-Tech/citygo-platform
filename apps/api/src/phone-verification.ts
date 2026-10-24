import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DomainError,
  PhoneVerification,
  type Database,
  type PhoneVerificationContext,
  type PhoneVerificationPolicy,
} from "@citygo/db";
import {
  phoneVerificationStartSchema,
  phoneVerificationResendSchema,
  phoneVerificationConfirmSchema,
} from "@citygo/contracts";
import { tokenHash } from "./auth.js";
import type { readConfig } from "@citygo/config";
import type { SmsRuDeliveryResult } from "./verification-delivery/sms-ru.js";
import type { ProstoSmsDeliveryResult } from "./verification-delivery/prosto-sms.js";

export type PhoneVerificationDelivery = (input: {
  phone: string;
  code: string;
  signal: AbortSignal;
}) => Promise<SmsRuDeliveryResult | ProstoSmsDeliveryResult>;
// The adapter owns its eight-second provider deadline; leave time to cancel
// and persist the admission outcome before this outer request guard expires.
export const PHONE_DELIVERY_DEADLINE_MS = 12_000;
export function phoneVerificationPolicy(
  config: ReturnType<typeof readConfig>,
): PhoneVerificationPolicy | undefined {
  if (
    config.PHONE_VERIFICATION_MODE === "disabled" ||
    !config.PHONE_VERIFICATION_SECRET
  )
    return undefined;
  return {
    identityKeyFingerprint: createHmac(
      "sha256",
      Buffer.from(config.PHONE_VERIFICATION_SECRET, "hex"),
    )
      .update("citygo-phone-identity-binding-v1")
      .digest("hex"),
    normalizationVersion: "e164-v1",
    limits: {
      userHourly: 3,
      phoneHourly: 3,
      ipHourly: 10,
      cooldownSeconds: 60,
      globalDaily:
        config.PHONE_SMS_GLOBAL_DAILY_LIMIT === "unlimited"
          ? null
          : config.PHONE_SMS_GLOBAL_DAILY_LIMIT,
      globalTotal:
        config.PHONE_SMS_GLOBAL_TOTAL_LIMIT === "unlimited"
          ? null
          : config.PHONE_SMS_GLOBAL_TOTAL_LIMIT,
    },
  };
}

export function registerPhoneVerification(
  app: FastifyInstance,
  options: {
    db: Database;
    config: ReturnType<typeof readConfig>;
    delivery?: PhoneVerificationDelivery;
    context: (request: FastifyRequest) => Promise<PhoneVerificationContext>;
  },
) {
  const selectedProvider = options.config.PHONE_VERIFICATION_MODE;
  const policy = phoneVerificationPolicy(options.config);
  const state = policy ? new PhoneVerification(options.db, policy) : undefined;
  const ready = async () =>
    !!state &&
    !!options.delivery &&
    ((selectedProvider === "sms_ru" && options.config.SMS_RU_MODE === "live") ||
      (selectedProvider === "prosto_sms" &&
        options.config.PROSTOSMS_MODE === "live")) &&
    (await state.readiness());
  const unavailable = async () => {
    if (!(await ready()))
      throw new DomainError(
        503,
        "Подтверждение телефона ещё не подключено. Подарок пока недоступен.",
      );
  };
  const expectProvider = (expected: "sms_ru" | "prosto_sms") => {
    if (selectedProvider !== "disabled" && expected !== selectedProvider)
      throw new DomainError(
        409,
        "Провайдер SMS изменился. Обновите условия подтверждения телефона.",
        "CONFLICT",
      );
  };
  const digest = (purpose: string, ...values: string[]) =>
    createHmac(
      "sha256",
      Buffer.from(options.config.PHONE_VERIFICATION_SECRET!, "hex"),
    )
      .update(JSON.stringify([purpose, ...values]))
      .digest("hex");
  const code = () => String(randomInt(1_000_000)).padStart(6, "0");
  async function deliver(
    id: string,
    phone: string,
    otp: string,
    codeHash: string,
  ) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([
        options.delivery!({
          phone: phone.slice(1),
          code: otp,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("SMS deadline"));
          }, PHONE_DELIVERY_DEADLINE_MS);
        }),
      ]);
      if (
        receipt.provider !== selectedProvider ||
        receipt.accepted !== true ||
        receipt.mode !== "live" ||
        receipt.simulated !== false
      )
        throw new Error("Simulated SMS cannot confirm a phone");
      await state!.markAccepted(id, codeHash);
    } catch {
      await state!.cancelDelivery(id, codeHash).catch(() => undefined);
      // Unknown provider outcomes are not automatically retried or refunded as quota.
      throw new DomainError(
        503,
        "Не удалось отправить SMS. Повторная отправка — только по вашему действию.",
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  app.get("/v1/phone-verification/policy", async (request) => {
    const ctx = await options.context(request);
    // Disabled installations do not query phone tables. Unbound installations
    // only check control readiness, never account gift history or challenges.
    const available = !!policy && (await ready());
    const giftStatus = available
      ? (await state!.status(ctx)).giftStatus
      : "unavailable";
    return {
      phoneVerification: !policy
        ? "disabled"
        : available
          ? "required"
          : "unavailable",
      deliveryProvider: policy ? selectedProvider : "none",
      giftAmountMicros: 500_000_000,
      giftStatus,
    };
  });
  const limits = {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  };
  app.post("/v1/phone-verification/start", limits, async (request) => {
    const ctx = await options.context(request);
    const { phone, expectedDeliveryProvider } =
      phoneVerificationStartSchema.parse(request.body);
    expectProvider(expectedDeliveryProvider);
    await unavailable();
    const id = randomUUID(),
      proof = randomBytes(32).toString("hex"),
      otp = code();
    const codeHash = digest("phone-otp", id, otp);
    const result = await state!.begin(ctx, {
      id,
      phoneKey: digest("phone-identity", phone),
      proofHash: tokenHash(proof),
      codeHash,
      ipKey: digest("phone-ip", request.ip),
    });
    await deliver(id, phone, otp, codeHash);
    return {
      challengeId: id,
      proof,
      expiresAt: result.expiresAt,
      resendAfterSeconds: 60,
    };
  });
  app.post("/v1/phone-verification/resend", limits, async (request) => {
    const ctx = await options.context(request);
    const input = phoneVerificationResendSchema.parse(request.body);
    expectProvider(input.expectedDeliveryProvider);
    await unavailable();
    const otp = code();
    const codeHash = digest("phone-otp", input.challengeId, otp);
    const result = await state!.resend(ctx, {
      id: input.challengeId,
      phoneKey: digest("phone-identity", input.phone),
      proofHash: tokenHash(input.proof),
      codeHash,
      ipKey: digest("phone-ip", request.ip),
    });
    await deliver(input.challengeId, input.phone, otp, codeHash);
    return {
      challengeId: input.challengeId,
      proof: input.proof,
      expiresAt: result.expiresAt,
      resendAfterSeconds: 60,
    };
  });
  app.post("/v1/phone-verification/confirm", limits, async (request) => {
    const ctx = await options.context(request);
    await unavailable();
    const input = phoneVerificationConfirmSchema.parse(request.body);
    return state!.confirm(ctx, {
      id: input.challengeId,
      phoneKey: digest("phone-identity", input.phone),
      proofHash: tokenHash(input.proof),
      codeHash: digest("phone-otp", input.challengeId, input.code),
    });
  });
}

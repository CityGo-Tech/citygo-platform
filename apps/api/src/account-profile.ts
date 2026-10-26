import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  accountEmailVerificationStartSchema,
  accountEmailVerificationResendSchema,
  accountEmailVerificationConfirmSchema,
} from "@citygo/contracts";
import {
  AccountProfile,
  DomainError,
  PhoneVerification,
  type AccountProfileContext,
  type Database,
  type EmailSendLimits,
} from "@citygo/db";
import type { readConfig } from "@citygo/config";
import type { RegistrationEmailDelivery } from "./email-registration.js";
import {
  phoneVerificationPolicy,
  type PhoneVerificationDelivery,
} from "./phone-verification.js";

export function registerAccountProfile(
  app: FastifyInstance,
  options: {
    db: Database;
    config: ReturnType<typeof readConfig>;
    emailDelivery?: RegistrationEmailDelivery;
    phoneDelivery?: PhoneVerificationDelivery;
    context: (request: FastifyRequest) => Promise<AccountProfileContext>;
  },
) {
  const config = options.config;
  const limits: EmailSendLimits | undefined =
    config.EMAIL_DELIVERY_PROVIDER === "yandex_postbox"
      ? {
          daily:
            config.EMAIL_SEND_DAILY_LIMIT === "unlimited"
              ? null
              : config.EMAIL_SEND_DAILY_LIMIT,
          total:
            config.EMAIL_SEND_TOTAL_LIMIT === "unlimited"
              ? null
              : config.EMAIL_SEND_TOTAL_LIMIT,
        }
      : undefined;
  const state = new AccountProfile(options.db, limits);
  const available =
    config.EMAIL_REGISTRATION_MODE === "required" &&
    !!options.emailDelivery &&
    /^[a-f0-9]{64}$/.test(config.EMAIL_REGISTRATION_SECRET ?? "");
  const policy = phoneVerificationPolicy(config);
  const phone = policy ? new PhoneVerification(options.db, policy) : undefined;
  const phoneReady = async () =>
    !!phone &&
    !!options.phoneDelivery &&
    ((config.PHONE_VERIFICATION_MODE === "prosto_sms" &&
      config.PROSTOSMS_MODE === "live") ||
      (config.PHONE_VERIFICATION_MODE === "sms_ru" &&
        config.SMS_RU_MODE === "live")) &&
    (await phone.readiness());
  const digest = (purpose: string, ...values: string[]) =>
    createHmac("sha256", Buffer.from(config.EMAIL_REGISTRATION_SECRET!, "hex"))
      .update(JSON.stringify([purpose, ...values]))
      .digest("hex");
  const proofHash = (id: string, proof: string) =>
    digest("account-email-proof", id, proof);
  const otp = () => String(randomInt(1_000_000)).padStart(6, "0");
  function requireDelivery() {
    if (!available)
      throw new DomainError(
        503,
        "Подтверждение почты пока недоступно. Попробуйте позже.",
      );
  }
  async function deliver(
    id: string,
    email: string,
    code: string,
    codeHash: string,
    expiresAt: string,
  ) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        options.emailDelivery!({
          email,
          code,
          expiresAt,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Delivery deadline"));
          }, 25_000);
        }),
      ]);
      await state.markSent(id, codeHash);
    } catch {
      await state.cancelDelivery(id, codeHash).catch(() => undefined);
      throw new DomainError(
        503,
        "Не удалось отправить письмо. Попробуйте позже.",
      );
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  app.get("/v1/account/profile", async (request) => {
    const profile = await state.summary(await options.context(request));
    return {
      userId: profile.userId,
      email: profile.email,
      emailVerified: profile.emailVerified,
      phoneVerified: profile.phoneVerified,
      giftStatus: profile.giftClaimed
        ? ("claimed" as const)
        : !profile.phoneVerified &&
            profile.emailVerified &&
            (await phoneReady())
          ? ("available" as const)
          : ("unavailable" as const),
      emailConfirmation:
        available && profile.email !== null
          ? ("available" as const)
          : ("unavailable" as const),
    };
  });
  const bounded = {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  };
  app.post("/v1/account/email/verification", bounded, async (request) => {
    const ctx = await options.context(request);
    requireDelivery();
    accountEmailVerificationStartSchema.parse(request.body);
    const profile = await state.summary(ctx);
    if (!profile.email)
      throw new DomainError(409, "Для этого аккаунта не указана почта");
    const id = randomUUID(),
      proof = randomBytes(32).toString("hex"),
      code = otp();
    const codeHash = digest("account-email-otp", id, code);
    const result = await state.begin({
      ...ctx,
      id,
      email: profile.email,
      proofHash: proofHash(id, proof),
      codeHash,
      // Same journal AND HMAC namespaces as registration/recovery: switching
      // endpoints cannot bypass recipient/IP/global email admissions.
      recipientKey: digest("registration-recipient", profile.email),
      ipKey: digest("registration-ip", request.ip),
    });
    await deliver(id, result.email, code, codeHash, result.expiresAt);
    return {
      challengeId: id,
      proof,
      expiresAt: result.expiresAt,
      resendAfterSeconds: 60,
    };
  });
  app.post(
    "/v1/account/email/verification/resend",
    bounded,
    async (request) => {
      const ctx = await options.context(request);
      requireDelivery();
      const input = accountEmailVerificationResendSchema.parse(request.body),
        code = otp();
      const codeHash = digest("account-email-otp", input.challengeId, code);
      const result = await state.resend({
        ...ctx,
        id: input.challengeId,
        proofHash: proofHash(input.challengeId, input.proof),
        codeHash,
        ipKey: digest("registration-ip", request.ip),
      });
      await deliver(result.id, result.email, code, codeHash, result.expiresAt);
      return { ...input, expiresAt: result.expiresAt, resendAfterSeconds: 60 };
    },
  );
  app.post(
    "/v1/account/email/verification/confirm",
    bounded,
    async (request) => {
      const ctx = await options.context(request);
      requireDelivery();
      const input = accountEmailVerificationConfirmSchema.parse(request.body);
      return state.confirm({
        ...ctx,
        id: input.challengeId,
        proofHash: proofHash(input.challengeId, input.proof),
        codeHash: digest("account-email-otp", input.challengeId, input.code),
      });
    },
  );
}

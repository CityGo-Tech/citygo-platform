import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  registrationWithConsentsSchema,
  emailRegistrationConfirmSchema,
  emailRegistrationResendSchema,
} from "@citygo/contracts";
import {
  DomainError,
  EmailRegistration,
  ServiceConsents,
  type ServiceAiPolicyResolver,
  type Database,
  type EmailSendLimits,
} from "@citygo/db";
import { hashPassword, newToken, tokenHash } from "./auth.js";

export type RegistrationEmailDelivery = (input: {
  email: string;
  code: string;
  expiresAt: string;
  signal: AbortSignal;
}) => Promise<void>;

// A transport is selected explicitly by server configuration. Provider
// acceptance is not inbox delivery; only the recipient's OTP proves access.
// Injected senders are allowed by buildApp only in isolated tests.
export function registerEmailRegistration(
  app: FastifyInstance,
  options: {
    db: Database;
    mode: "disabled" | "required";
    secret?: string;
    delivery?: RegistrationEmailDelivery;
    sendLimits?: EmailSendLimits;
    policyResolver?: ServiceAiPolicyResolver;
    setSession: (reply: FastifyReply, token: string) => void;
  },
) {
  const state = new EmailRegistration(
    options.db,
    options.sendLimits,
    options.policyResolver,
  );
  const consentState = new ServiceConsents(options.db, options.policyResolver);
  const available =
    options.mode === "required" &&
    !!options.delivery &&
    /^[a-f0-9]{64}$/.test(options.secret ?? "");
  const unavailable = () => {
    if (!available)
      throw new DomainError(
        503,
        "Подтверждение почты пока не подключено. Попробуйте позже.",
      );
  };
  const digest = (purpose: string, ...values: string[]) =>
    createHmac("sha256", Buffer.from(options.secret!, "hex"))
      .update(JSON.stringify([purpose, ...values]))
      .digest("hex");
  const code = () => String(randomInt(1_000_000)).padStart(6, "0");
  async function deliver(
    id: string,
    email: string,
    otp: string,
    codeHash: string,
    expiresAt: string,
  ) {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Delivery and password hashing never hold an SQL transaction open.
      await Promise.race([
        options.delivery!({
          email,
          code: otp,
          expiresAt,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          // Postbox's finite transport budget is <=20s. Keep this outer
          // safeguard above it, and below the client's default 30s deadline.
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Delivery deadline"));
          }, 25_000);
        }),
      ]);
      await state.markSent(id, codeHash);
    } catch {
      // CAS prevents a delayed failed sender from invalidating a newer resend.
      await state.cancelDelivery(id, codeHash).catch(() => undefined);
      throw new DomainError(
        503,
        "Не удалось отправить письмо. Попробуйте позже.",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  }
  app.get("/v1/auth/registration-policy", async () => ({
    consentPolicy: await consentState.policy(),
    emailVerification:
      options.mode === "disabled"
        ? ("disabled" as const)
        : available
          ? ("required" as const)
          : ("unavailable" as const),
  }));
  const limits = {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  };
  app.post("/v1/auth/email/register", limits, async (request) => {
    unavailable();
    const input = registrationWithConsentsSchema.parse(request.body);
    const id = randomUUID();
    const proof = randomBytes(32).toString("hex");
    const otp = code();
    const codeHash = digest("registration-otp", id, otp);
    const result = await state.begin({
      id,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      proofHash: tokenHash(proof),
      codeHash,
      recipientKey: digest("registration-recipient", input.email),
      ipKey: digest("registration-ip", request.ip),
      consents: input.consents,
      landingAttribution: input.landingAttribution,
    });
    await deliver(id, input.email, otp, codeHash, result.expiresAt);
    return {
      challengeId: id,
      proof,
      expiresAt: result.expiresAt,
      resendAfterSeconds: 60,
    };
  });
  app.post("/v1/auth/email/resend", limits, async (request) => {
    unavailable();
    const input = emailRegistrationResendSchema.parse(request.body);
    const otp = code();
    const codeHash = digest("registration-otp", input.challengeId, otp);
    const result = await state.resend({
      id: input.challengeId,
      proofHash: tokenHash(input.proof),
      codeHash,
      ipKey: digest("registration-ip", request.ip),
    });
    await deliver(
      input.challengeId,
      result.email,
      otp,
      codeHash,
      result.expiresAt,
    );
    return { ...input, expiresAt: result.expiresAt, resendAfterSeconds: 60 };
  });
  app.post("/v1/auth/email/confirm", limits, async (request, reply) => {
    unavailable();
    const input = emailRegistrationConfirmSchema.parse(request.body);
    const token = newToken();
    const user = await state.confirm({
      id: input.challengeId,
      proofHash: tokenHash(input.proof),
      codeHash: digest("registration-otp", input.challengeId, input.code),
      sessionHash: tokenHash(token),
    });
    options.setSession(reply, token);
    return {
      user,
      ...(request.headers["x-citygo-client"] === "native" ? { token } : {}),
    };
  });
}

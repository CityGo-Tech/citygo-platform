import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  passwordRecoveryRequestSchema,
  passwordRecoveryResendSchema,
  passwordRecoveryConfirmSchema,
} from "@citygo/contracts";
import {
  DomainError,
  PasswordRecovery,
  type Database,
  type EmailSendLimits,
} from "@citygo/db";
import { hashPassword } from "./auth.js";

export type PasswordRecoveryEmailDelivery = (input: {
  email: string;
  code: string;
  expiresAt: string;
  signal: AbortSignal;
}) => Promise<void>;

export function registerPasswordRecovery(
  app: FastifyInstance,
  options: {
    db: Database;
    mode: "disabled" | "required";
    secret?: string;
    delivery?: PasswordRecoveryEmailDelivery;
    sendLimits?: EmailSendLimits;
  },
) {
  const state = new PasswordRecovery(options.db, options.sendLimits);
  const available =
    options.mode === "required" &&
    !!options.delivery &&
    /^[a-f0-9]{64}$/.test(options.secret ?? "");
  const digest = (purpose: string, ...values: string[]) =>
    createHmac("sha256", Buffer.from(options.secret!, "hex"))
      .update(JSON.stringify([purpose, ...values]))
      .digest("hex");
  const unavailable = () => {
    if (!available || closing)
      throw new DomainError(
        503,
        "Восстановление доступа пока недоступно. Попробуйте позже.",
      );
  };
  const tasks = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closing = false;
  function deliver(
    id: string,
    email: string | undefined,
    otp: string,
    codeHash: string,
    expiresAt: string,
  ) {
    const controller = new AbortController();
    if (closing) controller.abort();
    controllers.add(controller);
    // Persist first, acknowledge the same shape for every address, and only then
    // start delivery. A slow or failing provider must never identify an account.
    const task = new Promise<void>((resolve) => setImmediate(resolve)).then(
      async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abort!: () => void;
        try {
          if (controller.signal.aborted) throw new Error("Delivery cancelled");
          const stopped = new Promise<never>((_, reject) => {
            abort = () => reject(new Error("Delivery cancelled"));
            controller.signal.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => controller.abort(), 25_000);
          });
          await Promise.race([
            email
              ? Promise.resolve().then(() =>
                  options.delivery!({
                    email,
                    code: otp,
                    expiresAt,
                    signal: controller.signal,
                  }),
                )
              : Promise.resolve(),
            stopped,
          ]);
          if (controller.signal.aborted) throw new Error("Delivery cancelled");
          await state.markSent(id, codeHash);
        } catch {
          // Never retain or log recipient, code, proof, password or provider errors.
          // The code-hash CAS cannot invalidate a newer manual resend.
          await state.cancelDelivery(id, codeHash).catch(() => undefined);
        } finally {
          if (timer) clearTimeout(timer);
          if (abort) controller.signal.removeEventListener("abort", abort);
          controller.abort();
          controllers.delete(controller);
        }
      },
    );
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  const stop = async () => {
    closing = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...tasks]);
  };
  // Runtime registers its DB onClose hook later. Cancel and settle before any
  // onClose hook can close the database; keep the final hook idempotent.
  app.addHook("preClose", stop);
  app.addHook("onClose", stop);
  app.get("/v1/auth/password-recovery-policy", async () => ({
    passwordRecovery: available
      ? ("available" as const)
      : ("unavailable" as const),
  }));
  const limits = {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
  };
  app.post("/v1/auth/password-recovery/request", limits, async (request) => {
    unavailable();
    const input = passwordRecoveryRequestSchema.parse(request.body);
    const id = randomUUID();
    const proof = randomBytes(32).toString("hex");
    const otp = String(randomInt(1_000_000)).padStart(6, "0");
    const codeHash = digest("password-recovery-otp", id, otp);
    const result = await state.begin({
      id,
      email: input.email,
      proofHash: digest("password-recovery-proof", proof),
      codeHash,
      // Admission is shared with registration to prevent bypassing email caps.
      recipientKey: digest("registration-recipient", input.email),
      ipKey: digest("registration-ip", request.ip),
    });
    deliver(id, result.email, otp, codeHash, result.expiresAt);
    return {
      challengeId: id,
      proof,
      expiresAt: result.expiresAt,
      resendAfterSeconds: 60,
    };
  });
  app.post("/v1/auth/password-recovery/resend", limits, async (request) => {
    unavailable();
    const input = passwordRecoveryResendSchema.parse(request.body);
    const otp = String(randomInt(1_000_000)).padStart(6, "0");
    const codeHash = digest("password-recovery-otp", input.challengeId, otp);
    const result = await state.resend({
      id: input.challengeId,
      proofHash: digest("password-recovery-proof", input.proof),
      codeHash,
      ipKey: digest("registration-ip", request.ip),
    });
    deliver(input.challengeId, result.email, otp, codeHash, result.expiresAt);
    return { ...input, expiresAt: result.expiresAt, resendAfterSeconds: 60 };
  });
  app.post("/v1/auth/password-recovery/confirm", limits, async (request) => {
    unavailable();
    const input = passwordRecoveryConfirmSchema.parse(request.body);
    await state.confirm({
      id: input.challengeId,
      proofHash: digest("password-recovery-proof", input.proof),
      codeHash: digest("password-recovery-otp", input.challengeId, input.code),
      newPasswordHash: await hashPassword(input.newPassword),
    });
    // Session revocation is already atomic in SQL. Do not send Set-Cookie:
    // a late recovery response could erase another owner's newer login cookie
    // before that response reaches the client's generation checks.
    return { passwordReset: true as const, sessionsRevoked: true as const };
  });
}

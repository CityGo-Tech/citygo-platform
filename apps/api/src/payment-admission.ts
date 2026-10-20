import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  paymentAdmissionCommandSchema,
  paymentAdmissionStatusSchema,
  paymentAdmissionUserStatusSchema,
} from "@citygo/contracts";
import { validatePaymentConfig, type readConfig } from "@citygo/config";
import {
  DomainError,
  type PaymentAdmission,
  type PaymentAdmissionBinding,
} from "@citygo/db";
import { tokenHash } from "./auth.js";
import {
  PaymentReconciler,
  type PaymentReconcileScheduler,
} from "./payment-reconciler.js";
import type { PaymentNotificationInbox } from "./payment-notifications.js";
import type { ApiDrain } from "./shutdown.js";

// A public policy/config identity, not a secret digest, deployment-file digest,
// key fingerprint or statement of fiscal compliance. Key rotation and technical
// AI quotas do not silently invalidate a reviewed unchanged payment policy.
export function createPaymentAdmissionBinding(
  config: ReturnType<typeof readConfig>,
): PaymentAdmissionBinding | undefined {
  if (config.YOOKASSA_MODE !== "live") return;
  validatePaymentConfig(config);
  const policy = {
    version: "citygo-payment-admission-v1",
    provider: "yookassa",
    mode: "live",
    merchantId: config.YOOKASSA_SHOP_ID!,
    webOrigin: new URL(config.WEB_ORIGIN).origin,
    returnPath: "/",
    tariffVersion: "citygo-10x-v1",
    receiptMode: config.YOOKASSA_RECEIPT_MODE,
    ...(config.YOOKASSA_FISCAL_PROFILE !== "disabled"
      ? { fiscalProfile: config.YOOKASSA_FISCAL_PROFILE }
      : {}),
  };
  return {
    merchantId: policy.merchantId,
    runtimePolicyId: createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex"),
  };
}
const empty = z.strictObject({});
function output<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid payment admission response");
  return parsed.data;
}
export function registerPaymentAdmission(
  app: FastifyInstance,
  options: {
    admission?: PaymentAdmission;
    sessionName: string;
    topUpAvailable(): Promise<boolean>;
    authenticate(request: FastifyRequest): Promise<{ id: string }>;
  },
) {
  async function context(request: FastifyRequest) {
    const user = await options.authenticate(request);
    const token = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : request.cookies[options.sessionName];
    if (!token) throw new DomainError(401, "Войдите в аккаунт");
    return { userId: user.id, sessionTokenHash: tokenHash(token) };
  }
  function configured() {
    if (!options.admission)
      throw new DomainError(503, "Боевой приём платежей не настроен");
    return options.admission;
  }
  app.get("/v1/admin/payments/admission", async (request) => {
    const actor = await context(request);
    empty.parse(request.query);
    return output(
      paymentAdmissionStatusSchema,
      await configured().statusAdmin(actor),
    );
  });
  app.post(
    "/v1/admin/payments/admission/commands",
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request) => {
      const actor = await context(request);
      empty.parse(request.query);
      const command = paymentAdmissionCommandSchema.parse(request.body);
      // Exact current session, active super_admin and password status are
      // checked again in the same DB transaction as CAS and immutable audit.
      return output(
        paymentAdmissionStatusSchema,
        await configured().command(actor, command),
      );
    },
  );
  app.get("/v1/payments/availability", async (request) => {
    await options.authenticate(request);
    empty.parse(request.query);
    return output(paymentAdmissionUserStatusSchema, {
      available: await options.topUpAvailable(),
    });
  });
}

// One lifecycle per API process; shared DB run leases fence replicas. Closing
// checkout deliberately does not disable this settlement/refund reconciler.
export function registerPaymentReconciliation(
  app: FastifyInstance,
  options: {
    admission: PaymentAdmission;
    inbox: Pick<
      PaymentNotificationInbox,
      | "enqueueKnownPending"
      | "processPending"
      | "hasUnresolvedVerificationFailures"
    >;
    drain: ApiDrain;
    testing: boolean;
    scheduler?: PaymentReconcileScheduler;
  },
) {
  let run: Awaited<ReturnType<PaymentAdmission["beginReconciliation"]>> = null;
  const reconciler = new PaymentReconciler({
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    enabled: async () => {
      run = await options.admission.beginReconciliation();
      return run !== null;
    },
    run: (limit) =>
      options.drain.run(async () => {
        if (!run) throw new Error("Payment reconciliation lease missing");
        await options.inbox.enqueueKnownPending(limit);
        const result = await options.inbox.processPending(limit);
        if (await options.inbox.hasUnresolvedVerificationFailures())
          throw new Error("Payment verification requires review");
        return result;
      }),
    recordSuccess: async () => {
      const owned = run;
      if (!owned) throw new Error("Payment reconciliation lease missing");
      // A timed-out/rebound/disabled run is not fresh trusted health. In
      // particular it must never overwrite a later failed/replacement run.
      const accepted = await options.admission.completeReconciliation({
        ...owned,
        success: true,
      });
      if (!accepted) throw new Error("Payment reconciliation lease changed");
      run = null;
    },
    recordFailure: async () => {
      const owned = run;
      run = null;
      if (owned)
        await options.admission.completeReconciliation({
          ...owned,
          success: false,
        });
    },
  });
  // Synthetic inject tests never create real timers or dispatch background I/O.
  // A fake scheduler is accepted only by buildApp's isolated test guard.
  if (!options.testing || options.scheduler)
    app.addHook("onReady", async () => {
      reconciler.start();
    });
  // preClose precedes every onClose hook, including runtime's DB close hook.
  app.addHook("preClose", async () => {
    await reconciler.stop();
    // stop may race with enabled(): the DB lease can commit before that async
    // check returns, after which #cycle correctly skips provider work. It then
    // has no success/failure callback to release the captured lease. Drain it
    // here before DB shutdown; the exact runId/revision fences a replacement.
    const owned = run;
    run = null;
    if (owned)
      await options.admission.completeReconciliation({
        ...owned,
        success: false,
      });
  });
}

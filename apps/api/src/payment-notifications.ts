import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError, type Database } from "@citygo/db";
import type { YooKassaMode } from "./yookassa.js";

const eventSchema = z.enum([
  "payment.succeeded",
  "payment.canceled",
  "payment.waiting_for_capture",
  "refund.succeeded",
]);
const envelope = z.object({
  type: z.literal("notification"),
  event: eventSchema,
  object: z.object({ id: z.uuid() }),
});
const rowSchema = z.strictObject({
  id: z.uuid(),
  event: eventSchema,
  objectId: z.uuid(),
  localId: z.uuid(),
  userId: z.string().regex(/^[1-9][0-9]*$/),
  merchantId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  test: z.boolean(),
  attemptCount: z.number().int().nonnegative(),
  leaseToken: z.uuid(),
});
export type PaymentNotification = z.infer<typeof rowSchema> & {
  kind: "payment" | "refund";
};
export const PAYMENT_NOTIFICATION_PATH = "/v1/payments/yookassa/notifications";

// This durable inbox is not settlement evidence. The callback must perform an
// authenticated provider GET and the existing idempotent money-journal path.
// Notifications for an unbound/lost create response are intentionally ignored;
// recovery remains the same-key checkout/manual review workflow, not metadata.
export class PaymentNotificationInbox {
  #db: Database;
  #merchantId: string;
  #test: boolean;
  #reconcile: (
    notification: PaymentNotification,
  ) => Promise<"verified" | "retry">;

  constructor(
    db: Database,
    options: {
      mode: YooKassaMode;
      merchantId: string;
      reconcile: (
        notification: PaymentNotification,
      ) => Promise<"verified" | "retry">;
    },
  ) {
    if (
      !["test", "live"].includes(options.mode) ||
      !/^[1-9][0-9]{0,19}$/.test(options.merchantId)
    )
      throw new Error("Payment notification mode requires configuration");
    this.#db = db;
    this.#merchantId = options.merchantId;
    this.#test = options.mode === "test";
    this.#reconcile = options.reconcile;
  }

  async enqueue(raw: unknown): Promise<"queued" | "duplicate" | "ignored"> {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success)
      throw new DomainError(400, "Некорректное уведомление платежного сервиса");
    const { event, object } = parsed.data;
    const isPayment = event.startsWith("payment.");
    // Table/column selection is exclusively from the allowlisted event enum.
    const result = await this.#db.query<{ id: string }>(
      `insert into payment_notification_inbox
       (id,event,object_id,payment_order_id,refund_id,merchant_id,test)
       select $1,$2,$3::uuid,${isPayment ? "p.id,null" : "null,p.id"},p.merchant_id,p.test
       from ${isPayment ? "payment_topup_orders" : "payment_refunds"} p
       where ${isPayment ? "p.provider_payment_id" : "p.provider_refund_id"}=$3::text
         and p.merchant_id=$4 and p.test=$5
       on conflict(event,object_id,merchant_id,test) do nothing returning id`,
      [randomUUID(), event, object.id, this.#merchantId, this.#test],
    );
    if (result.rows.length) return "queued";
    const known = await this.#db.query(
      `select id from payment_notification_inbox
       where event=$1 and object_id=$2 and merchant_id=$3 and test=$4`,
      [event, object.id, this.#merchantId, this.#test],
    );
    return known.rows.length ? "duplicate" : "ignored";
  }

  async processPending(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new DomainError(
        400,
        "Недопустимый размер очереди проверки платежей",
      );
    let processed = 0;
    let retained = 0;
    for (let index = 0; index < limit; index++) {
      const leaseToken = randomUUID();
      // Claim exactly one row per iteration so a slow earlier callback cannot
      // let unstarted rows' leases expire. Provider I/O is outside this query.
      const claimed = await this.#db.query(
        `with candidate as (
           select id from payment_notification_inbox
           where merchant_id=$1 and test=$2 and status<>'processed'
             and next_attempt_at<=clock_timestamp()
             and (status='pending' or lease_until<=clock_timestamp())
           order by next_attempt_at,created_at,id for update skip locked limit 1
         ), claimed as (
           update payment_notification_inbox n set status='processing',
             lease_token=$3,lease_until=clock_timestamp()+interval '60 seconds',
             attempt_count=attempt_count+1
           from candidate c where n.id=c.id
           returning n.*
         ) select n.id,n.event,n.object_id::text as "objectId",
           coalesce(n.payment_order_id,n.refund_id)::text as "localId",
           coalesce(p.user_id,r.user_id)::text as "userId",
           n.merchant_id as "merchantId",n.test,n.attempt_count as "attemptCount",
           n.lease_token::text as "leaseToken"
         from claimed n left join payment_topup_orders p on p.id=n.payment_order_id
         left join payment_refunds r on r.id=n.refund_id`,
        [this.#merchantId, this.#test, leaseToken],
      );
      if (!claimed.rows.length) break;
      const row = rowSchema.parse(claimed.rows[0]);
      const notification: PaymentNotification = {
        ...row,
        kind: row.event.startsWith("payment.") ? "payment" : "refund",
      };
      let verified = false;
      let reason = "retry_required";
      try {
        verified = (await this.#reconcile(notification)) === "verified";
      } catch {
        // Never persist provider bodies, credential details or arbitrary errors.
        reason = "verification_failed";
      }
      const completed = await this.#db.query(
        `update payment_notification_inbox set status=$3,
           processed_at=case when $3='processed' then clock_timestamp() else null end,
           lease_token=null,lease_until=null,last_reason=$4,
           next_attempt_at=clock_timestamp()+interval '60 seconds'
         where id=$1 and lease_token=$2 and status='processing' returning id`,
        [
          row.id,
          leaseToken,
          verified ? "processed" : "pending",
          verified ? null : reason,
        ],
      );
      // A lost lease cannot complete another worker's claim. Monetary callbacks
      // remain idempotent even if a crash occurs after the provider GET/posting.
      if (completed.rows.length && verified) processed++;
      else retained++;
    }
    return { processed, retained };
  }
}

export function registerPaymentNotifications(
  app: FastifyInstance,
  inbox: PaymentNotificationInbox,
) {
  app.post(
    PAYMENT_NOTIFICATION_PATH,
    {
      bodyLimit: 16 * 1024,
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      // Explicit machine-only ingress, never a CSRF exception for a browser.
      if (
        request.headers.origin !== undefined ||
        request.headers.cookie !== undefined ||
        request.headers.authorization !== undefined
      )
        return reply.code(403).send({ error: "Machine notification required" });
      await inbox.enqueue(request.body);
      // Ack only after the durable INSERT (or known duplicate/ignored object).
      // No provider request, balance mutation or incoming status is trusted.
      return { accepted: true };
    },
  );
}

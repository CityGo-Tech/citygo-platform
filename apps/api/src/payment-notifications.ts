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
// The immutable inbox guard compares provider text to PostgreSQL's canonical
// UUID text. Do not cast malformed/uppercase legacy identities or silently
// rewrite their financial binding; they require a separate operator review.
const canonicalProviderIdPattern =
  "^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
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

  async enqueueKnownPending(limit = 10): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25)
      throw new DomainError(400, "Недопустимый размер поиска платежей");
    // Recover lost webhooks from existing DB-owned identities, not from client
    // metadata. Excluding every already represented object prevents old pending
    // or immutable processed hints from starving later missing notifications.
    // Filter legacy IDs BEFORE LIMIT so poison rows cannot occupy every batch.
    const candidates = await this.#db.query<{
      kind: "payment" | "refund";
      objectId: string;
    }>(
      `select kind,object_id as "objectId" from (
         select 'payment' as kind,p.id,p.provider_payment_id as object_id,p.updated_at
         from payment_topup_orders p
         where p.merchant_id=$1 and p.test=$2 and p.status in ('queued','pending')
           and p.provider_payment_id is not null and p.provider_payment_id ~ $4
           and not exists(select 1 from payment_notification_inbox n
             where n.payment_order_id=p.id and n.merchant_id=p.merchant_id and n.test=p.test)
         union all
         select 'refund' as kind,r.id,r.provider_refund_id as object_id,r.updated_at
         from payment_refunds r
         where r.merchant_id=$1 and r.test=$2 and r.status in ('pending','unknown')
           and r.provider_refund_id is not null and r.provider_refund_id ~ $4
           and not exists(select 1 from payment_notification_inbox n
             where n.refund_id=r.id and n.merchant_id=r.merchant_id and n.test=r.test)
       ) known order by updated_at,id,kind limit $3`,
      [this.#merchantId, this.#test, limit, canonicalProviderIdPattern],
    );
    let queued = 0;
    for (const candidate of candidates.rows) {
      // Defense in depth for legacy/corrupt adapters. No arbitrary string is
      // passed to the UUID-casting enqueue query or a provider callback.
      if (
        !["payment", "refund"].includes(candidate.kind) ||
        !z.uuid().safeParse(candidate.objectId).success ||
        candidate.objectId !== candidate.objectId.toLowerCase()
      )
        continue;
      const outcome = await this.enqueue({
        type: "notification",
        event:
          candidate.kind === "payment"
            ? "payment.succeeded"
            : "refund.succeeded",
        object: { id: candidate.objectId },
      });
      if (outcome === "queued") queued++;
    }
    return queued;
  }

  async hasUnresolvedVerificationFailures(): Promise<boolean> {
    const observed = await this.#db.query<{ failed: boolean }>(
      `select
         exists(select 1 from payment_notification_inbox n
           where n.merchant_id=$1 and n.test=$2 and n.status<>'processed'
             and n.last_reason='verification_failed')
         or exists(select 1 from payment_topup_orders p
           where p.merchant_id=$1 and p.test=$2 and (p.status='review_required'
             or (p.status in ('queued','pending') and p.provider_payment_id is not null
               and p.provider_payment_id !~ $3)))
         or exists(select 1 from payment_refunds r
           where r.merchant_id=$1 and r.test=$2 and (r.status='review_required'
             or r.review_reason is not null
             or (r.status in ('pending','unknown') and r.provider_refund_id is not null
               and r.provider_refund_id !~ $3))) as failed`,
      [this.#merchantId, this.#test, canonicalProviderIdPattern],
    );
    const failed = observed.rows[0]?.failed;
    if (typeof failed !== "boolean")
      throw new Error("Invalid payment verification health response");
    // Normal provider pending/retry_required is not a failed authenticated GET.
    return failed;
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

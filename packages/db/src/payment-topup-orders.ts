import { randomUUID } from "node:crypto";
import { z } from "zod";
import { creditUserIdSchema } from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import { lockPaymentMode } from "./payment-isolation.js";
import {
  assertLiveCheckoutAdmission,
  type PaymentAdmissionBinding,
} from "./payment-admission.js";

const idSchema = z.uuid();
const amountSchema = z.number().int().min(100).max(1_000_000);
const merchantSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const paymentSchema = merchantSchema;
const statusSchema = z.enum(["pending", "canceled", "succeeded"]);
const returnUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
const confirmationSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const providerSchema = z.strictObject({
  providerPaymentId: paymentSchema,
  status: statusSchema,
  confirmationUrl: confirmationSchema.optional(),
});
type ProviderUpdate = z.infer<typeof providerSchema>;
export type PaymentTopupOrder = {
  id: string;
  userId: string;
  requestId: string;
  amountKopeks: number;
  currency: "RUB";
  merchantId: string;
  test: boolean;
  returnUrl: string;
  createPayload: {
    amount: { value: string; currency: "RUB" };
    capture: true;
    confirmation: { type: "redirect"; return_url: string };
    metadata: { citygo_order_id: string };
    description: string;
  };
  createKey: string;
  createdAt: string;
  updatedAt: string;
  providerPaymentId: string | null;
  status: "queued" | "pending" | "canceled" | "succeeded" | "review_required";
  confirmationUrl: string | null;
  credited: boolean;
};
type StoredOrder = Omit<PaymentTopupOrder, "amountKopeks"> & {
  amountKopeks: number | string;
};

// Server-only durable checkout state. No provider I/O, no inference of payment
// from a return URL, and no money is created by this class. Only the separately
// verified AiCreditLedger posting can make an order credited/succeeded.
export class PaymentTopupOrders {
  private admissionBinding?: PaymentAdmissionBinding;
  constructor(
    private db: Database,
    admissionBinding?: PaymentAdmissionBinding,
  ) {
    // Trusted server configuration only. Legacy/internal database primitives
    // without a binding remain usable on historical schemas before migration22;
    // the live HTTP transport must always construct this class with a binding.
    this.admissionBinding = admissionBinding
      ? {
          merchantId: admissionBinding.merchantId,
          runtimePolicyId: admissionBinding.runtimePolicyId,
        }
      : undefined;
  }

  private async lockUser(tx: Sql, userId: string) {
    creditUserIdSchema.parse(userId);
    const found = await tx.query(
      "select id from users where id=$1 for update",
      [userId],
    );
    if (!found.rows.length) throw new DomainError(404, "Аккаунт не найден");
  }

  private async read(
    userId: string,
    id: string,
    sql: Sql,
  ): Promise<PaymentTopupOrder> {
    const row = (
      await sql.query<StoredOrder>(
        `select o.id,o.id as "createKey",o.user_id::text as "userId",o.request_id as "requestId",
       o.amount_kopeks as "amountKopeks",o.currency,o.merchant_id as "merchantId",o.test,
       o.return_url as "returnUrl",o.create_payload as "createPayload",
       o.provider_payment_id as "providerPaymentId",o.status,o.confirmation_url as "confirmationUrl",
       to_char(o.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
       to_char(o.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt",
       exists(select 1 from ai_credit_topups p where p.operation_id=o.id and p.user_id=o.user_id
         and p.provider_payment_id=o.provider_payment_id and p.paid_kopeks=o.amount_kopeks
         and p.credited_micros=o.amount_kopeks::bigint*10000 and p.merchant_id=o.merchant_id
         and p.test=o.test) as credited
       from payment_topup_orders o where o.id=$1 and o.user_id=$2`,
        [id, userId],
      )
    ).rows[0];
    if (!row) throw new DomainError(404, "Пополнение не найдено");
    return { ...row, amountKopeks: Number(row.amountKopeks) };
  }

  async get(userId: string, orderId: string) {
    creditUserIdSchema.parse(userId);
    idSchema.parse(orderId);
    return this.read(userId, orderId, this.db);
  }

  async create(
    userId: string,
    requestId: string,
    amountKopeks: number,
    merchantId: string,
    test: boolean,
    returnUrl: string,
  ) {
    creditUserIdSchema.parse(userId);
    idSchema.parse(requestId);
    amountSchema.parse(amountKopeks);
    merchantSchema.parse(merchantId);
    z.boolean().parse(test);
    returnUrlSchema.parse(returnUrl);
    if (
      !test &&
      this.admissionBinding &&
      merchantId !== this.admissionBinding.merchantId
    )
      throw new DomainError(
        503,
        "Платёжный магазин не соответствует допуску оплаты",
      );
    return this.db.transaction(async (tx) => {
      await lockPaymentMode(tx, test ? "test" : "real");
      // Shared lock order: account security -> admission -> payer -> order.
      // Replays also pass this gate. No provider I/O while holding these locks.
      if (!test && this.admissionBinding)
        await assertLiveCheckoutAdmission(tx, this.admissionBinding);
      await this.lockUser(tx, userId);
      const existing = (
        await tx.query<{ id: string }>(
          "select id from payment_topup_orders where user_id=$1 and request_id=$2 for update",
          [userId, requestId],
        )
      ).rows[0];
      if (existing) {
        const previous = await this.read(userId, existing.id, tx);
        if (
          previous.amountKopeks !== amountKopeks ||
          previous.merchantId !== merchantId ||
          previous.test !== test ||
          previous.returnUrl !== returnUrl
        )
          throw new DomainError(
            409,
            "Запрос пополнения уже использован с другими параметрами",
          );
        return previous;
      }
      const id = randomUUID();
      const payload: PaymentTopupOrder["createPayload"] = {
        amount: {
          value: `${Math.floor(amountKopeks / 100)}.${String(amountKopeks % 100).padStart(2, "0")}`,
          currency: "RUB",
        },
        capture: true,
        confirmation: { type: "redirect", return_url: returnUrl },
        metadata: { citygo_order_id: id },
        description: test
          ? "Пополнение тестового баланса CityGo"
          : "Пополнение баланса CityGo",
      };
      await tx.query(
        `insert into payment_topup_orders(id,user_id,request_id,amount_kopeks,merchant_id,test,return_url,create_payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          userId,
          requestId,
          amountKopeks,
          merchantId,
          test,
          returnUrl,
          JSON.stringify(payload),
        ],
      );
      return this.read(userId, id, tx);
    });
  }

  async recordProvider(userId: string, orderId: string, raw: ProviderUpdate) {
    creditUserIdSchema.parse(userId);
    idSchema.parse(orderId);
    const update = providerSchema.parse(raw);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockUser(tx, userId);
        await tx.query(
          "select id from payment_topup_orders where id=$1 and user_id=$2 for update",
          [orderId, userId],
        );
        const previous = await this.read(userId, orderId, tx);
        if (
          previous.providerPaymentId &&
          previous.providerPaymentId !== update.providerPaymentId
        )
          throw new DomainError(
            409,
            "Пополнение уже связано с другим платежом",
          );
        if (
          (previous.status === "succeeded" || previous.status === "canceled") &&
          previous.status !== update.status
        )
          throw new DomainError(
            409,
            "Завершённый платёж нельзя перевести в другое состояние",
          );
        if (
          previous.confirmationUrl &&
          update.confirmationUrl &&
          previous.confirmationUrl !== update.confirmationUrl
        )
          throw new DomainError(409, "Ссылка подтверждения платежа изменилась");
        const posting = await tx.query(
          `select operation_id from ai_credit_topups where operation_id=$1 and user_id=$2
             and provider_payment_id=$3 and paid_kopeks=$4 and credited_micros=$4::bigint*10000
             and merchant_id=$5 and test=$6`,
          [
            orderId,
            userId,
            update.providerPaymentId,
            previous.amountKopeks,
            previous.merchantId,
            previous.test,
          ],
        );
        if (update.status === "canceled" && posting.rows.length)
          throw new DomainError(
            409,
            "Начисленный платёж нельзя отменить сменой статуса",
          );
        if (update.status === "succeeded") {
          if (!posting.rows.length)
            throw new DomainError(
              409,
              "Начисление платежа ещё не подтверждено",
            );
        }
        // No mutable credited flag: this status is merely a provider observation
        // guarded by the matching immutable ledger receipt above.
        await tx.query(
          `update payment_topup_orders set provider_payment_id=$3,status=$4,
           confirmation_url=coalesce(confirmation_url,$5),updated_at=clock_timestamp()
           where id=$1 and user_id=$2`,
          [
            orderId,
            userId,
            update.providerPaymentId,
            update.status,
            update.confirmationUrl ?? null,
          ],
        );
        return this.read(userId, orderId, tx);
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        throw new DomainError(409, "Платёж уже связан с другим пополнением");
      throw error;
    }
  }

  async markReviewRequired(userId: string, orderId: string) {
    creditUserIdSchema.parse(userId);
    idSchema.parse(orderId);
    return this.db.transaction(async (tx) => {
      await this.lockUser(tx, userId);
      await tx.query(
        "select id from payment_topup_orders where id=$1 and user_id=$2 for update",
        [orderId, userId],
      );
      const previous = await this.read(userId, orderId, tx);
      if (
        previous.status !== "succeeded" &&
        previous.status !== "canceled" &&
        previous.status !== "review_required"
      )
        await tx.query(
          "update payment_topup_orders set status='review_required',updated_at=clock_timestamp() where id=$1 and user_id=$2",
          [orderId, userId],
        );
      return this.read(userId, orderId, tx);
    });
  }
}

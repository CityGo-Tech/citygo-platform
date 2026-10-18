import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AI_WELCOME_CREDIT_MICROS,
  CITYGO_MAX_AMOUNT_MICROS,
  citygoTopUpMicrosFromPaidKopeks,
  creditUserIdSchema,
  type AiCredit,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const amountSchema = z.number().int().min(0).max(CITYGO_MAX_AMOUNT_MICROS);
const operationSchema = z.uuid();
const confirmedTopUpSchema = z.strictObject({
  providerPaymentId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  paidKopeks: z.number().int().min(1).max(1_000_000_000),
  merchantId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  test: z.boolean(),
  verifiedAt: z.iso.datetime(),
  verification: z.literal("server_get_succeeded"),
  currency: z.literal("RUB"),
});
type ConfirmedTopUp = z.infer<typeof confirmedTopUpSchema>;
type Entry = {
  user_id: string;
  kind: string;
  amount_micros: string;
  hold_id: string | null;
};

// Trusted server ledger primitive. Not a payment endpoint or provider billing API.
// Every operation locks users -> credit account. No network while locks are held.
export class AiCreditLedger {
  constructor(
    private db: Database,
    private chargingStatus: AiCredit["chargingStatus"] = "not_connected",
    private topUpAvailable = false,
  ) {}

  private async lock(tx: Sql, userId: string, actorId?: string) {
    creditUserIdSchema.parse(userId);
    if (actorId) creditUserIdSchema.parse(actorId);
    // Consistent numeric order also protects two admins granting each other.
    const users = await tx.query<{ id: string }>(
      "select id::text from users where id=$1 or id=$2 order by users.id for update",
      [userId, actorId ?? userId],
    );
    if (
      !users.rows.some((row) => row.id === userId) ||
      (actorId && !users.rows.some((row) => row.id === actorId))
    )
      throw new DomainError(404, "Аккаунт не найден");
    await tx.query(
      "insert into ai_credit_accounts(user_id) values ($1) on conflict do nothing",
      [userId],
    );
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [userId],
    );
  }

  private async entry(tx: Sql, operationId: string) {
    return (
      await tx.query<Entry>(
        "select user_id::text,kind,amount_micros::text,hold_id::text from ai_credit_entries where operation_id=$1",
        [operationId],
      )
    ).rows[0];
  }

  async status(userId: string, sql: Sql = this.db): Promise<AiCredit> {
    creditUserIdSchema.parse(userId);
    // One statement snapshot: concurrent grants/holds cannot mix totals/history.
    const row = (
      await sql.query<{
        granted: string;
        held: string;
        spent: string;
        bonus_granted: boolean;
        history: AiCredit["history"];
        pending: NonNullable<AiCredit["pending"]>;
      }>(
        `select coalesce(a.granted_micros,0)::text as granted,
      coalesce(a.held_micros,0)::text as held,coalesce(a.spent_micros,0)::text as spent,
      exists(select 1 from ai_credit_entries b where b.user_id=$1 and b.kind='bonus') as bonus_granted,
      coalesce((select jsonb_agg(jsonb_build_object('id',e.id::text,'kind',e.kind,
        'amountMicros',e.amount_micros,'createdAt',to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by e.id desc)
        from (select id,kind,amount_micros,created_at from ai_credit_entries where user_id=$1 order by id desc limit 20) e),'[]'::jsonb) as history,
      coalesce((select jsonb_agg(jsonb_build_object('holdId',p.hold_id,'amountMicros',p.amount_micros,'responseComplete',p.response_complete))
        from (select c.hold_id,e.amount_micros,c.response_complete from ai_credit_charges c
          join ai_credit_entries e on e.operation_id=c.hold_id where c.user_id=$1
          and not exists(select 1 from ai_credit_entries r where r.hold_id=c.hold_id)
          order by c.created_at desc limit 20) p),'[]'::jsonb) as pending
      from users u left join ai_credit_accounts a on a.user_id=u.id where u.id=$1`,
        [userId],
      )
    ).rows[0];
    if (!row) throw new DomainError(404, "Аккаунт не найден");
    const granted = Number(row.granted),
      held = Number(row.held),
      spent = Number(row.spent);
    return {
      currency: "RUB",
      bonusGranted: row.bonus_granted,
      grantedMicros: granted,
      heldMicros: held,
      spentMicros: spent,
      availableMicros: granted - held - spent,
      history: row.history,
      chargingStatus: this.chargingStatus,
      pending: row.pending,
      topUpAvailable: this.topUpAvailable,
    };
  }

  // Authorization belongs to the API allowlist. Amount/currency are never input.
  async grantWelcome(userId: string, actorId: string) {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, userId, actorId);
      const prior = await tx.query(
        "select id from ai_credit_entries where user_id=$1 and kind='bonus'",
        [userId],
      );
      if (prior.rows.length) return;
      await tx.query(
        "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id) values ($1,$2,'bonus',$3,$4)",
        [userId, randomUUID(), AI_WELCOME_CREDIT_MICROS, actorId],
      );
      const result = await tx.query(
        "update ai_credit_accounts set granted_micros=granted_micros+$2::bigint where user_id=$1 and granted_micros <= $3::bigint-$2::bigint returning user_id",
        [userId, AI_WELCOME_CREDIT_MICROS, CITYGO_MAX_AMOUNT_MICROS],
      );
      if (!result.rows.length)
        throw new DomainError(409, "Достигнут технический предел баланса");
      await tx.query(
        "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'ai-credit-welcome-granted','ai-credit',$2,$3)",
        [
          actorId,
          userId,
          JSON.stringify({
            currency: "RUB",
            amountMicros: AI_WELCOME_CREDIT_MICROS,
          }),
        ],
      );
    });
    return this.status(userId);
  }

  // TRUSTED SERVER ONLY. This primitive validates a verified payment identity;
  // it does NOT authenticate a webhook, fetch YooKassa, or accept client proof.
  // The caller must perform an authenticated server GET and verify succeeded,
  // paid, exact amount/currency/merchant/order ownership and test/live mode first.
  // Never expose this method as an endpoint accepting the same shape verbatim.
  async topUpConfirmed(
    userId: string,
    operationId: string,
    raw: ConfirmedTopUp,
  ) {
    creditUserIdSchema.parse(userId);
    operationSchema.parse(operationId);
    const input = confirmedTopUpSchema.parse(raw);
    const credited = citygoTopUpMicrosFromPaidKopeks(input.paidKopeks);
    try {
      await this.db.transaction(async (tx) => {
        await this.lock(tx, userId);
        const priorOperation = await this.entry(tx, operationId);
        const priorPayment = (
          await tx.query<{
            user_id: string;
            operation_id: string;
            paid_kopeks: string;
            merchant_id: string;
            test: boolean;
          }>(
            `select user_id::text,operation_id,paid_kopeks::text,merchant_id,test
             from ai_credit_topups where provider_payment_id=$1`,
            [input.providerPaymentId],
          )
        ).rows[0];
        if (
          priorOperation &&
          (!priorPayment ||
            priorPayment.operation_id !== operationId ||
            priorOperation.user_id !== userId ||
            priorOperation.kind !== "topup" ||
            Number(priorOperation.amount_micros) !== credited)
        )
          throw new DomainError(
            409,
            "Операция баланса уже использована с другими параметрами",
          );
        if (priorPayment) {
          if (
            priorPayment.user_id !== userId ||
            Number(priorPayment.paid_kopeks) !== input.paidKopeks ||
            priorPayment.merchant_id !== input.merchantId ||
            priorPayment.test !== input.test
          )
            throw new DomainError(409, "Платёж уже связан с другой операцией");
          // A repeated notification may have a new verification time or request
          // UUID. The original payment/posting remains authoritative and intact.
          return;
        }
        const result = await tx.query(
          `update ai_credit_accounts set granted_micros=granted_micros+$2::bigint
           where user_id=$1 and granted_micros <= $3::bigint-$2::bigint returning user_id`,
          [userId, credited, CITYGO_MAX_AMOUNT_MICROS],
        );
        if (!result.rows.length)
          throw new DomainError(409, "Достигнут технический предел баланса");
        await tx.query(
          "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'topup',$3)",
          [userId, operationId, credited],
        );
        await tx.query(
          `insert into ai_credit_topups(provider_payment_id,operation_id,user_id,paid_kopeks,
           credited_micros,merchant_id,test,verified_at,verification_receipt)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            input.providerPaymentId,
            operationId,
            userId,
            input.paidKopeks,
            credited,
            input.merchantId,
            input.test,
            input.verifiedAt,
            JSON.stringify(input),
          ],
        );
      });
    } catch (error) {
      // Different users can race for one globally unique payment/operation ID.
      // A losing transaction rolls back the account update and its entry.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        throw new DomainError(409, "Платёж или операция уже учтены");
      throw error;
    }
    return this.status(userId);
  }

  // Supplied transaction joins the attempt + operator-budget reservation atomically.
  async hold(
    userId: string,
    operationId: string,
    amountMicros: number,
    transaction?: Sql,
  ) {
    operationSchema.parse(operationId);
    amountSchema.positive().parse(amountMicros);
    const work = async (tx: Sql) => {
      await this.lock(tx, userId);
      const previous = await this.entry(tx, operationId);
      if (previous) {
        if (
          previous.user_id === userId &&
          previous.kind === "hold" &&
          Number(previous.amount_micros) === amountMicros
        )
          return;
        throw new DomainError(
          409,
          "Операция баланса уже использована с другими параметрами",
        );
      }
      const result = await tx.query(
        "update ai_credit_accounts set held_micros=held_micros+$2 where user_id=$1 and granted_micros-held_micros-spent_micros >= $2 returning user_id",
        [userId, amountMicros],
      );
      if (!result.rows.length)
        throw new DomainError(
          409,
          "Недостаточно доступного баланса CityGo для резерва этого ответа.",
          "AI_CREDIT_EXHAUSTED",
        );
      await tx.query(
        "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values ($1,$2,'hold',$3)",
        [userId, operationId, amountMicros],
      );
    };
    if (transaction) await work(transaction);
    else await this.db.transaction(work);
  }

  // Only trusted confirmed charge or proven no-dispatch can resolve a hold.
  // Timeout/cancellation is NOT proof of zero charge; leave that hold pending.
  async resolve(
    userId: string,
    operationId: string,
    holdId: string,
    resolution:
      | { kind: "settle"; amountMicros: number }
      | { kind: "release"; amountMicros: 0 },
    transaction?: Sql,
  ) {
    operationSchema.parse(operationId);
    operationSchema.parse(holdId);
    amountSchema.parse(resolution.amountMicros);
    if (
      !["settle", "release"].includes(resolution.kind) ||
      (resolution.kind === "release" && resolution.amountMicros !== 0)
    )
      throw new DomainError(400, "Некорректное завершение резерва");
    const work = async (tx: Sql) => {
      await this.lock(tx, userId);
      const previous = await this.entry(tx, operationId);
      if (previous) {
        if (
          previous.user_id === userId &&
          previous.kind === resolution.kind &&
          previous.hold_id === holdId &&
          Number(previous.amount_micros) === resolution.amountMicros
        )
          return;
        throw new DomainError(
          409,
          "Операция баланса уже использована с другими параметрами",
        );
      }
      const held = await this.entry(tx, holdId);
      if (!held || held.user_id !== userId || held.kind !== "hold")
        throw new DomainError(404, "Резерв не найден");
      const finished = await tx.query(
        "select id from ai_credit_entries where hold_id=$1",
        [holdId],
      );
      if (finished.rows.length)
        throw new DomainError(409, "Резерв уже завершён");
      if (resolution.amountMicros > Number(held.amount_micros))
        throw new DomainError(409, "Списание превышает подтверждённый резерв");
      await tx.query(
        "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id) values ($1,$2,$3,$4,$5)",
        [userId, operationId, resolution.kind, resolution.amountMicros, holdId],
      );
      await tx.query(
        "update ai_credit_accounts set held_micros=held_micros-$2,spent_micros=spent_micros+$3 where user_id=$1",
        [userId, Number(held.amount_micros), resolution.amountMicros],
      );
    };
    if (transaction) await work(transaction);
    else await this.db.transaction(work);
  }
}

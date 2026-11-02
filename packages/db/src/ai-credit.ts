import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AI_WELCOME_CREDIT_MICROS,
  CITYGO_MAX_AMOUNT_MICROS,
  citygoTopUpMicrosFromPaidKopeks,
  creditUserIdSchema,
  citygoDebitFromRealCostRub,
  citygoTariffSnapshotSchema,
  routerAiChargeSchema,
  type AiCredit,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import type { CustomerBillingMode } from "./postpay-charges.js";
import type { AiRequestCostLimitMode } from "./request-cost-limit.js";
import { DomainError } from "./errors.js";
import { lockPaymentMode } from "./payment-isolation.js";
import {
  reserveCreditSources,
  resolveCreditSources,
} from "./credit-source-lots.js";
import {
  assertCreditDebtPaid,
  assertFixed5Admission,
  FIXED_CITYGO_HOLD_MICROS,
  MAX_OVERDRAFT_REAL_CEILING_MICROS,
  repayCreditDebt,
  type AiCreditReservationMode,
} from "./credit-debt.js";

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
// Isolation-aware holds/top-ups lock security -> users -> credit account; other
// resolutions keep users -> credit account. No network while locks are held.
export class AiCreditLedger {
  constructor(
    private db: Database,
    private chargingStatus: AiCredit["chargingStatus"] = "not_connected",
    private topUpAvailable: boolean | (() => Promise<boolean>) = false,
    private reservationMode: AiCreditReservationMode = "full",
    private includeGigaFixedFees = false,
    private requestCostLimitMode: AiRequestCostLimitMode = "operator_ceiling",
    private customerBillingMode: CustomerBillingMode = "legacy",
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
    // A status hint, never checkout authorization. The order transaction checks
    // live admission again. Resolve before the balance snapshot; no provider I/O
    // belongs in this callback. Callers owning a transaction pre-resolve it.
    const topUpAvailable =
      typeof this.topUpAvailable === "function"
        ? await this.topUpAvailable()
        : this.topUpAvailable;
    const postpaySchema =
      (
        await sql.query<{ present: boolean }>(
          "select to_regclass('public.credit_postpay_liabilities') is not null as present",
        )
      ).rows[0]?.present === true;
    const postpayDebt = postpaySchema
      ? `(select coalesce(sum(d.principal_micros-coalesce(r.paid,0)),0) from credit_postpay_liabilities d left join
      (select charge_id,sum(amount_micros) as paid from credit_postpay_repayments where user_id=$1 group by charge_id)r on r.charge_id=d.charge_id where d.user_id=$1)`
      : "0";
    // One statement snapshot: concurrent grants/holds cannot mix totals/history.
    const row = (
      await sql.query<{
        granted: string;
        held: string;
        spent: string;
        bonus_granted: boolean;
        history: AiCredit["history"];
        pending: NonNullable<AiCredit["pending"]>;
        outstanding_debt: string;
      }>(
        `select coalesce(a.granted_micros,0)::text as granted,
      coalesce(a.held_micros,0)::text as held,coalesce(a.spent_micros,0)::text as spent,
      exists(select 1 from ai_credit_entries b where b.user_id=$1 and b.kind='bonus') as bonus_granted,
      coalesce((select jsonb_agg(jsonb_build_object('id',e.id::text,'kind',e.kind,
        'amountMicros',e.amount_micros,'createdAt',to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by e.id desc)
        from (select id,kind,amount_micros,created_at from ai_credit_entries where user_id=$1 and kind<>'postpay_open' order by id desc limit 20) e),'[]'::jsonb) as history,
      coalesce((select jsonb_agg(jsonb_build_object('holdId',p.hold_id,'amountMicros',p.amount_micros,'responseComplete',p.response_complete))
        from (select c.hold_id,e.amount_micros,c.response_complete,c.created_at from ai_credit_charges c
          join ai_credit_entries e on e.operation_id=c.hold_id where c.user_id=$1
          and not exists(select 1 from ai_credit_entries r where r.hold_id=c.hold_id)
          ${
            this.includeGigaFixedFees
              ? `union all select f.hold_id,e.amount_micros,false as response_complete,f.created_at
          from gigachat_request_fees f join ai_credit_entries e on e.operation_id=f.hold_id
          where f.user_id=$1 and f.state in ('reserved','dispatched') and e.kind='hold'
          and not exists(select 1 from ai_credit_entries r where r.hold_id=f.hold_id)`
              : ""
          }
          order by created_at desc limit 20) p),'[]'::jsonb) as pending,
      ((select coalesce(sum(d.principal_micros-coalesce(r.paid,0)),0)
        from credit_charge_debts d left join
          (select debt_hold_id,sum(amount_micros) as paid from credit_debt_repayments where user_id=$1 group by debt_hold_id) r
          on r.debt_hold_id=d.hold_id where d.user_id=$1)+${postpayDebt})::text as outstanding_debt
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
      topUpAvailable,
      ...(this.customerBillingMode === "postpay_actual_v1"
        ? {
            billingPolicy: "postpay_actual_v1" as const,
            minimumRequestBalanceMicros: 10,
          }
        : this.reservationMode === "fixed5_overdraft"
          ? {
              reservationMode: this.reservationMode,
              minimumRequestBalanceMicros: FIXED_CITYGO_HOLD_MICROS,
            }
          : {}),
      ...(this.reservationMode === "fixed5_overdraft" ||
      Number(row.outstanding_debt) > 0
        ? { outstandingDebtMicros: Number(row.outstanding_debt) }
        : {}),
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
        await lockPaymentMode(tx, input.test ? "test" : "real");
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
      await lockPaymentMode(tx, "real");
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
      if (this.reservationMode === "fixed5_overdraft") {
        if (amountMicros !== FIXED_CITYGO_HOLD_MICROS)
          throw new DomainError(400, "Fixed5 требует ровно 5 ₽ CityGo резерва");
        await assertFixed5Admission(tx, userId, this.requestCostLimitMode);
      } else await assertCreditDebtPaid(tx, userId);
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
      await reserveCreditSources(tx, userId, operationId, amountMicros);
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
      const heldAmount = Number(held.amount_micros);
      const extra = Math.max(0, resolution.amountMicros - heldAmount);
      if (extra > 0) {
        const charge = (
          await tx.query<{
            reservation_mode: string;
            cost_limit_mode: AiRequestCostLimitMode;
            balance_before_hold_micros: string | null;
            real_ceiling_micros: string;
            tariff_snapshot: unknown;
            receipt: unknown;
            generation_id: string | null;
            model: string;
            upstream: string;
            dispatched: boolean;
            response_complete: boolean;
          }>(
            `select reservation_mode,cost_limit_mode,balance_before_hold_micros::text,real_ceiling_micros::text,tariff_snapshot,receipt,generation_id,
              model,upstream,dispatched,response_complete from ai_credit_charges where hold_id=$1 and user_id=$2`,
            [holdId, userId],
          )
        ).rows[0];
        if (
          !charge ||
          charge.reservation_mode !== "fixed5_overdraft" ||
          heldAmount !== FIXED_CITYGO_HOLD_MICROS ||
          !charge.dispatched ||
          !charge.response_complete ||
          Number(charge.real_ceiling_micros) < 500_000 ||
          (charge.cost_limit_mode !== "user_balance" &&
            Number(charge.real_ceiling_micros) >
              MAX_OVERDRAFT_REAL_CEILING_MICROS)
        )
          throw new DomainError(
            409,
            "Списание превышает подтверждённый резерв",
          );
        const receipt = routerAiChargeSchema.parse(charge.receipt);
        const tariff = citygoTariffSnapshotSchema.parse(charge.tariff_snapshot);
        const exact = (
          await tx.query<{ within: boolean }>(
            "select $1::numeric*1000000 <= $2::bigint as within",
            [receipt.costRub, charge.real_ceiling_micros],
          )
        ).rows[0]!.within;
        if (
          tariff.version !== "citygo-10x-v1" ||
          receipt.reference !== holdId ||
          receipt.generationId !== charge.generation_id ||
          receipt.model !== charge.model ||
          receipt.upstream !== charge.upstream ||
          (charge.cost_limit_mode !== "user_balance" && !exact) ||
          (charge.cost_limit_mode === "user_balance" &&
            (charge.balance_before_hold_micros === null ||
              BigInt(charge.balance_before_hold_micros) / 10n !==
                BigInt(charge.real_ceiling_micros))) ||
          citygoDebitFromRealCostRub(receipt.costRub, tariff)
            .citygoDebitMicros !== resolution.amountMicros
        )
          throw new DomainError(
            409,
            "Долг не подтверждён точной стоимостью попытки",
          );
      }
      // The public integer journal has a finite lifetime range. A provider
      // receipt outside remaining technical capacity must roll back as pending,
      // never post an unreadable counter, partial debit or guessed free charge.
      const account = (
        await tx.query<{ spent: string }>(
          "select spent_micros::text as spent from ai_credit_accounts where user_id=$1",
          [userId],
        )
      ).rows[0];
      if (
        !account ||
        !Number.isSafeInteger(Number(account.spent)) ||
        Number(account.spent) >
          CITYGO_MAX_AMOUNT_MICROS - resolution.amountMicros
      )
        throw new DomainError(
          409,
          "Достигнут технический предел денежного журнала AI",
          "AI_CREDIT_UNAVAILABLE",
        );
      await resolveCreditSources(tx, userId, holdId, {
        ...resolution,
        amountMicros: Math.min(resolution.amountMicros, heldAmount),
      });
      await tx.query(
        "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id) values ($1,$2,$3,$4,$5)",
        [userId, operationId, resolution.kind, resolution.amountMicros, holdId],
      );
      if (extra > 0)
        await tx.query(
          "insert into credit_charge_debts(hold_id,user_id,principal_micros) values($1,$2,$3)",
          [holdId, userId, extra],
        );
      await tx.query(
        "update ai_credit_accounts set held_micros=held_micros-$2,spent_micros=spent_micros+$3 where user_id=$1",
        [userId, heldAmount, resolution.amountMicros],
      );
      await repayCreditDebt(tx, userId);
    };
    if (transaction) await work(transaction);
    else await this.db.transaction(work);
  }
}

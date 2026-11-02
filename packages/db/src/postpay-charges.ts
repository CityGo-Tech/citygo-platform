import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CITYGO_10X_TARIFF,
  CITYGO_MAX_AMOUNT_MICROS,
  citygoDebitFromRealCostRub,
  creditUserIdSchema,
  creditGenerationIdSchema,
  routerAiChargeSchema,
  type RouterAiCharge,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import { lockPaymentMode } from "./payment-isolation.js";
import { repayCreditDebt } from "./credit-debt.js";
export type CustomerBillingMode = "legacy" | "postpay_actual_v1";
const uuid = z.uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
export type PostpayAttempt = {
  id: string;
  user_id: string;
  thread_id: string;
  request_id: string;
  provider: "routerai" | "gigachat";
  protocol: "responses" | "chat/completions" | "gigachat";
  model: string;
  execution_key: string;
  policy_id: string;
  upstream: string | null;
  state: string;
  dispatched: boolean;
  response_complete: boolean;
  generation_id: string | null;
  receipt: RouterAiCharge | null;
  settlement_operation_id: string | null;
  balance_before_micros: string;
  real_ceiling_micros: string | null;
  fixed_fee_micros: string;
  response_message_id: string | null;
  reconcile_token: string | null;
};
export async function capturePostpayBalance(
  tx: Sql,
  userId: string,
  fixedFee = false,
) {
  creditUserIdSchema.parse(userId);
  await lockPaymentMode(tx, "real");
  await tx.query("select id from users where id=$1 for update", [userId]);
  await tx.query(
    "select user_id from ai_credit_accounts where user_id=$1 for update",
    [userId],
  );
  await repayCreditDebt(tx, userId);
  const a = (
    await tx.query<{ available: string; spent: string; review: boolean }>(
      "select (granted_micros-held_micros-spent_micros)::text as available,spent_micros::text as spent,billing_review_required as review from ai_credit_accounts where user_id=$1",
      [userId],
    )
  ).rows[0];
  const available = Number(a?.available),
    minimum = fixedFee ? 3_000_000 : 10;
  if (a?.review)
    throw new DomainError(
      409,
      "Баланс требует сверки источников. Обратитесь в поддержку.",
      "AI_CREDIT_UNAVAILABLE",
    );
  if (
    !Number.isSafeInteger(available) ||
    available < minimum ||
    available > CITYGO_MAX_AMOUNT_MICROS
  )
    throw new DomainError(
      409,
      "Недостаточно средств на балансе CityGo. Пополните баланс.",
      "AI_CREDIT_EXHAUSTED",
    );
  if (
    !Number.isSafeInteger(Number(a?.spent)) ||
    Number(a?.spent) > CITYGO_MAX_AMOUNT_MICROS - minimum
  )
    throw new DomainError(
      409,
      "Достигнут технический предел денежного журнала AI",
      "AI_CREDIT_UNAVAILABLE",
    );
  return {
    balance: available,
    realCeiling: fixedFee ? null : Number(BigInt(available) / 10n),
  };
}

/** Durable post-payment. No hold or source reservation is ever created here.
 * A dispatch is never retried; only identity-bound GET receipts are reconciled.
 * Interrupted/unproven terminal outcomes remain pending without blocking chat. */
export class PostpayCharges {
  constructor(private db: Database) {}
  async admit(
    tx: Sql,
    input: {
      userId: string;
      threadId: string;
      requestId: string;
      provider: "routerai" | "gigachat";
      protocol: "responses" | "chat/completions" | "gigachat";
      model: string;
      upstream?: string;
      executionKey: string;
      policyId: string;
      fixedFee?: boolean;
    },
  ) {
    uuid.parse(input.requestId);
    digest.parse(input.executionKey);
    digest.parse(input.policyId);
    const balance = await capturePostpayBalance(
        tx,
        input.userId,
        input.fixedFee === true,
      ),
      id = randomUUID();
    if ((input.provider === "gigachat") !== (input.fixedFee === true))
      throw new DomainError(409, "Некорректная цена режима");
    await tx.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros) values($1,$2,'postpay_open',0)",
      [input.userId, id],
    );
    await tx.query(
      `insert into ai_postpay_attempts(id,user_id,thread_id,request_id,provider,protocol,model,upstream,execution_key,policy_id,tariff_snapshot,balance_before_micros,real_ceiling_micros,fixed_fee_micros)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.userId,
        input.threadId,
        input.requestId,
        input.provider,
        input.protocol,
        input.model,
        input.upstream ?? null,
        input.executionKey,
        input.policyId,
        JSON.stringify(CITYGO_10X_TARIFF),
        balance.balance,
        balance.realCeiling,
        input.fixedFee ? 3_000_000 : 0,
      ],
    );
    return id;
  }
  async get(
    userId: string,
    id: string,
    tx: Sql = this.db,
  ): Promise<PostpayAttempt> {
    creditUserIdSchema.parse(userId);
    uuid.parse(id);
    const row = (
      await tx.query<PostpayAttempt>(
        "select p.*,p.id::text,p.user_id::text,p.thread_id::text,p.request_id::text,p.response_message_id::text,p.balance_before_micros::text,p.real_ceiling_micros::text,p.fixed_fee_micros::text from ai_postpay_attempts p where id=$1 and user_id=$2",
        [id, userId],
      )
    ).rows[0];
    if (!row) throw new DomainError(404, "Операция ответа не найдена");
    return row;
  }
  private async locked(tx: Sql, userId: string, id: string) {
    await tx.query("select id from users where id=$1 for update", [userId]);
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [userId],
    );
    await tx.query(
      "select id from ai_postpay_attempts where id=$1 and user_id=$2 for update",
      [id, userId],
    );
    return this.get(userId, id, tx);
  }
  async dispatch(userId: string, id: string, transaction?: Sql) {
    const work = async (tx: Sql) => {
      const p = await this.locked(tx, userId, id);
      if (p.state !== "admitted" || p.dispatched)
        throw new DomainError(409, "Повторный вызов модели запрещён");
      await tx.query(
        "update ai_postpay_attempts set state='dispatched',dispatched=true,next_check_at=clock_timestamp()+interval '30 seconds' where id=$1",
        [id],
      );
    };
    if (transaction) await work(transaction);
    else await this.db.transaction(work);
  }
  async identify(userId: string, id: string, generation: string) {
    creditGenerationIdSchema.parse(generation);
    await this.db.transaction(async (tx) => {
      const p = await this.locked(tx, userId, id);
      if (
        !p.dispatched ||
        p.provider !== "routerai" ||
        (p.generation_id && p.generation_id !== generation)
      )
        throw new DomainError(
          409,
          "Идентификатор генерации не соответствует операции",
        );
      if (p.generation_id === generation) return;
      await tx.query(
        "update ai_postpay_attempts set generation_id=$2 where id=$1",
        [id, generation],
      );
    });
  }
  async answer(
    tx: Sql,
    id: string,
    threadId: string,
    requestId: string,
    messageId: string,
  ) {
    const r = await tx.query(
      "update ai_postpay_attempts set response_complete=true,response_message_id=$4,state='pending',next_check_at=clock_timestamp() where id=$1 and thread_id=$2 and request_id=$3 and dispatched and state in ('dispatched','pending') returning id",
      [id, threadId, requestId, messageId],
    );
    if (!r.rows.length)
      throw new DomainError(409, "Оплата не соответствует завершённому ответу");
  }
  async interrupted(userId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const p = await this.locked(tx, userId, id);
      if (p.state === "settled" || p.state === "no_charge") return;
      if (p.dispatched)
        await tx.query(
          "update ai_postpay_attempts set state='pending',next_check_at=clock_timestamp()+interval '30 seconds' where id=$1",
          [id],
        );
      else await this.closeFree(tx, p);
    });
  }
  async closeFree(tx: Sql, p: PostpayAttempt) {
    if (p.state === "no_charge") return p.settlement_operation_id!;
    if (p.state === "settled" || (p.provider === "routerai" && p.dispatched))
      throw new DomainError(409, "Неизвестная стоимость не является нулевой");
    const op = randomUUID();
    await tx.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id) values($1,$2,'release',0,$3)",
      [p.user_id, op, p.id],
    );
    await tx.query(
      "update ai_postpay_attempts set state='no_charge',settlement_operation_id=$2,reconcile_token=null,reconcile_until=null where id=$1",
      [p.id, op],
    );
    return op;
  }
  private async post(
    tx: Sql,
    p: PostpayAttempt,
    debit: number,
    receipt: RouterAiCharge | null,
  ) {
    if (p.state === "settled") return p.settlement_operation_id!;
    const account = (
      await tx.query<{ spent: string }>(
        "select spent_micros::text as spent from ai_credit_accounts where user_id=$1",
        [p.user_id],
      )
    ).rows[0];
    if (
      !account ||
      !Number.isSafeInteger(debit) ||
      debit < 0 ||
      debit > CITYGO_MAX_AMOUNT_MICROS - Number(account.spent)
    )
      throw new DomainError(
        409,
        "Достигнут технический предел денежного журнала AI",
        "AI_CREDIT_UNAVAILABLE",
      );
    const op = randomUUID();
    await tx.query(
      "insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,hold_id) values($1,$2,'settle',$3,$4)",
      [p.user_id, op, debit, p.id],
    );
    await tx.query(
      "update ai_postpay_attempts set state='settled',settlement_operation_id=$2,receipt=$3,reconcile_token=null,reconcile_until=null where id=$1",
      [p.id, op, receipt ? JSON.stringify(receipt) : null],
    );
    if (debit > 0)
      await tx.query(
        "insert into credit_postpay_liabilities(charge_id,user_id,principal_micros) values($1,$2,$3)",
        [p.id, p.user_id, debit],
      );
    await tx.query(
      "update ai_credit_accounts set spent_micros=spent_micros+$2 where user_id=$1",
      [p.user_id, debit],
    );
    await repayCreditDebt(tx, p.user_id);
    await tx.query(
      "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)values($1,'ai-postpay-settled','ai-postpay',$2,$3)",
      [
        p.user_id,
        p.id,
        JSON.stringify({
          debitMicros: debit,
          costRub: receipt?.costRub ?? null,
          balanceAtAdmissionMicros: Number(p.balance_before_micros),
          realCeilingMicros:
            p.real_ceiling_micros === null
              ? null
              : Number(p.real_ceiling_micros),
          billingPolicy: "postpay_actual_v1",
        }),
      ],
    );
    return op;
  }
  async settleRouter(userId: string, id: string, raw: RouterAiCharge) {
    const receipt = routerAiChargeSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const p = await this.locked(tx, userId, id);
      if (
        p.provider !== "routerai" ||
        !p.dispatched ||
        receipt.reference !== id ||
        receipt.generationId !== p.generation_id ||
        receipt.model !== p.model ||
        receipt.upstream !== p.upstream
      )
        throw new DomainError(
          409,
          "Стоимость не соответствует принятой попытке",
        );
      if (p.state === "settled") {
        if (
          p.receipt?.costRub !== receipt.costRub ||
          p.receipt?.amountMicros !== receipt.amountMicros
        )
          throw new DomainError(409, "Подтверждённая стоимость изменилась");
        return true;
      }
      if (p.state === "no_charge")
        throw new DomainError(409, "Операция завершена без списания");
      await tx.query(
        "update ai_postpay_attempts set observed_receipt=$2,observed_at=clock_timestamp() where id=$1",
        [id, JSON.stringify(receipt)],
      );
      // GET /generation documents no finality flag. A zero/positive observation of
      // an interrupted response never becomes a fabricated terminal receipt.
      if (!p.response_complete || Number(receipt.costRub) == 0) return false;
      await this.post(
        tx,
        p,
        citygoDebitFromRealCostRub(receipt.costRub, CITYGO_10X_TARIFF)
          .citygoDebitMicros,
        receipt,
      );
      return true;
    });
  }
  async settleFixed(tx: Sql, userId: string, id: string) {
    const p = await this.locked(tx, userId, id);
    if (
      p.provider !== "gigachat" ||
      !p.response_complete ||
      !p.dispatched ||
      Number(p.fixed_fee_micros) !== 3_000_000
    )
      throw new DomainError(409, "Не подтверждён успешный ответ Минимума");
    return this.post(tx, p, 3_000_000, null);
  }
  async claimDue() {
    return this.db.transaction(async (tx) => {
      const p = (
        await tx.query<{ id: string; user_id: string }>(
          "select id::text,user_id::text from ai_postpay_attempts where provider='routerai' and state in ('dispatched','pending') and generation_id is not null and check_count<64 and created_at>clock_timestamp()-interval '7 days' and next_check_at<=clock_timestamp() and (reconcile_until is null or reconcile_until<clock_timestamp()) order by response_complete desc,next_check_at,id limit 1 for update skip locked",
        )
      ).rows[0];
      if (!p) return null;
      const token = randomUUID();
      await tx.query(
        "update ai_postpay_attempts set reconcile_token=$2,reconcile_until=clock_timestamp()+interval '60 seconds',check_count=least(check_count::bigint+1,2147483647)::int where id=$1",
        [p.id, token],
      );
      return { attempt: await this.get(p.user_id, p.id, tx), token };
    });
  }
  async finishCheck(userId: string, id: string, token: string) {
    uuid.parse(token);
    await this.db.query(
      "update ai_postpay_attempts set reconcile_token=null,reconcile_until=null,next_check_at=clock_timestamp()+least(21600,30*power(2,least(check_count,10))) * interval '1 second' where id=$1 and user_id=$2 and reconcile_token=$3 and state in ('dispatched','pending')",
      [id, userId, token],
    );
  }
}

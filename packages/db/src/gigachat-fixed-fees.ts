import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "./index.js";
import { AiCreditLedger } from "./ai-credit.js";
import { DomainError } from "./errors.js";
import { lockPaymentMode } from "./payment-isolation.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid();
const pricingSchema = z.strictObject({
  pricingId: digest,
  accountRef: digest,
  scope: z.literal("GIGACHAT_API_PERS"),
  leaseMs: z.number().int().min(90000).max(330000).optional(),
});
export type GigaChatFixedFeeInput = z.infer<typeof pricingSchema>;
export type GigaChatFixedFeeState =
  "reserved" | "dispatched" | "succeeded" | "failed" | "expired";
export type GigaChatFixedFee = {
  holdId: string;
  userId: string;
  threadId: string;
  requestId: string;
  chatLease: string;
  leaseToken: string;
  expiresAt: string;
  state: GigaChatFixedFeeState;
  responseMessageId: string | null;
  servedModel: string | null;
  accountRef: string;
  snapshot: Record<string, unknown>;
};
const conflict = () =>
  new DomainError(409, "Операция ответа не соответствует принятому запросу");
const busy = () =>
  new DomainError(
    503,
    "Этот режим сейчас занят. Попробуйте немного позже.",
    "AI_MODE_UNAVAILABLE",
  );
export function parseGigaChatFixedFeeInput(
  value: unknown,
): GigaChatFixedFeeInput {
  const parsed = pricingSchema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(400, "Некорректные условия режима ответа");
  return parsed.data;
}

// The price is a product fee, not a fabricated provider invoice or a ×10 rate.
// All cash movements still use the existing gift-first/paid-FIFO ledger.
export class GigaChatFixedFees {
  private ledger: AiCreditLedger;
  constructor(private db: Database) {
    this.ledger = new AiCreditLedger(
      db,
      "not_connected",
      false,
      "fixed5_overdraft",
    );
  }
  async lockAccount(tx: Sql, userId: string) {
    await lockPaymentMode(tx, "real");
    if (
      !(await tx.query("select id from users where id=$1 for update", [userId]))
        .rows.length
    )
      throw conflict();
    if (
      !(
        await tx.query(
          "select user_id from ai_credit_accounts where user_id=$1 for update",
          [userId],
        )
      ).rows.length
    )
      throw conflict();
  }
  async get(
    userId: string,
    holdId: string,
    tx: Sql = this.db,
    lock = false,
  ): Promise<GigaChatFixedFee> {
    id.parse(holdId);
    const result = await tx.query<GigaChatFixedFee>(
      `select hold_id::text as "holdId",user_id::text as "userId",thread_id::text as "threadId",request_id::text as "requestId",
 chat_lease::text as "chatLease",lease_token::text as "leaseToken",expires_at::text as "expiresAt",state,
 response_message_id::text as "responseMessageId",served_model as "servedModel",account_ref as "accountRef",snapshot
 from gigachat_request_fees where hold_id=$1 and user_id=$2${lock ? " for update" : ""}`,
      [holdId, userId],
    );
    if (!result.rows[0]) throw new DomainError(404, "Резерв ответа не найден");
    return result.rows[0];
  }
  async reserve(
    tx: Sql,
    input: {
      userId: string;
      threadId: string;
      requestId: string;
      chatLease: string;
      catalogId: string;
      executionKey: string;
      pricing: GigaChatFixedFeeInput;
    },
  ) {
    const pricing = parseGigaChatFixedFeeInput(input.pricing);
    digest.parse(input.catalogId);
    digest.parse(input.executionKey);
    id.parse(input.chatLease);
    const holdId = randomUUID(),
      leaseToken = randomUUID();
    // Same security/user/account order as every other credit admission. Capacity
    // contention rolls back the hold, allocations, attempt and daily counters.
    await this.ledger.hold(input.userId, holdId, 5000000, tx);
    await tx.query(
      "insert into gigachat_account_leases(account_ref) values($1) on conflict do nothing",
      [pricing.accountRef],
    );
    const slot = (
      await tx.query<{ lease_token: string | null }>(
        "select lease_token from gigachat_account_leases where account_ref=$1 for update",
        [pricing.accountRef],
      )
    ).rows[0];
    // An expired lease is first reconciled under its original user's locks;
    // another user never steals it or locks accounts in a different order.
    if (!slot || slot.lease_token !== null) throw busy();
    const snapshot = {
      version: "citygo-gigachat-flat3-success-v1",
      provider: "gigachat",
      mode: "minimum",
      model: "GigaChat-3-Ultra",
      scope: "GIGACHAT_API_PERS",
      feeCitygoMicros: 3000000,
      holdCitygoMicros: 5000000,
      operatorCostRubMicros: 0,
      pricingId: pricing.pricingId,
      accountRef: pricing.accountRef,
      catalogId: input.catalogId,
      executionKey: input.executionKey,
    };
    await tx.query(
      `insert into gigachat_request_fees(hold_id,user_id,thread_id,request_id,chat_lease,catalog_id,pricing_id,account_ref,
 execution_key,snapshot,lease_token,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,clock_timestamp()+$12::integer*interval '1 millisecond')`,
      [
        holdId,
        input.userId,
        input.threadId,
        input.requestId,
        input.chatLease,
        input.catalogId,
        pricing.pricingId,
        pricing.accountRef,
        input.executionKey,
        JSON.stringify(snapshot),
        leaseToken,
        pricing.leaseMs ?? 180000,
      ],
    );
    await tx.query(
      `update gigachat_account_leases set lease_token=$2,hold_id=$3,expires_at=f.expires_at
 from gigachat_request_fees f where gigachat_account_leases.account_ref=$1 and f.hold_id=$3`,
      [pricing.accountRef, leaseToken, holdId],
    );
    return holdId;
  }
  private async assertLive(tx: Sql, fee: GigaChatFixedFee) {
    const live = await tx.query(
      `select 1 from gigachat_account_leases l join gigachat_request_fees f on f.hold_id=l.hold_id
 where l.account_ref=$1 and l.hold_id=$2 and l.lease_token=$3 and l.expires_at>clock_timestamp()
 and f.state in ('reserved','dispatched') for update of l`,
      [fee.accountRef, fee.holdId, fee.leaseToken],
    );
    if (!live.rows.length) throw conflict();
  }
  async dispatch(userId: string, holdId: string) {
    await this.db.transaction(async (tx) => {
      await this.lockAccount(tx, userId);
      const fee = await this.get(userId, holdId, tx, true);
      if (fee.state !== "reserved") throw conflict();
      const request = await tx.query(
        `select 1 from chat_requests r join agent_threads t on t.id=r.thread_id
 where r.thread_id=$1 and r.request_id=$2 and r.status='running' and t.user_id=$3 and t.lease_token=$4
 and t.busy_until>clock_timestamp() for update of t`,
        [fee.threadId, fee.requestId, userId, fee.chatLease],
      );
      if (!request.rows.length) throw conflict();
      await this.assertLive(tx, fee);
      await tx.query(
        "update gigachat_request_fees set state='dispatched' where hold_id=$1",
        [holdId],
      );
    });
  }
  // Caller owns security -> user/account -> thread locks and persists the
  // completed answer in this same transaction before invoking this method.
  async settleSuccess(
    tx: Sql,
    fee: GigaChatFixedFee,
    input: { messageId: string; servedModel: string },
  ) {
    if (
      fee.state !== "dispatched" ||
      !/^GigaChat-3-Ultra(?::[A-Za-z0-9._-]{1,100})?$/.test(input.servedModel)
    )
      throw conflict();
    await this.assertLive(tx, fee);
    const operationId = randomUUID();
    await this.ledger.resolve(
      fee.userId,
      operationId,
      fee.holdId,
      { kind: "settle", amountMicros: 3000000 },
      tx,
    );
    await tx.query(
      `update gigachat_request_fees set state='succeeded',response_message_id=$2,served_model=$3,
 resolution_operation_id=$4,resolved_at=clock_timestamp() where hold_id=$1`,
      [fee.holdId, input.messageId, input.servedModel, operationId],
    );
    await tx.query(
      "update gigachat_account_leases set lease_token=null,hold_id=null,expires_at=null where account_ref=$1 and hold_id=$2 and lease_token=$3",
      [fee.accountRef, fee.holdId, fee.leaseToken],
    );
  }
  async releaseFailure(
    tx: Sql,
    fee: GigaChatFixedFee,
    outcome: "failed" | "expired" = "failed",
  ) {
    if (fee.state === "succeeded") throw conflict();
    if (fee.state === "reserved" || fee.state === "dispatched") {
      const operationId = randomUUID();
      await this.ledger.resolve(
        fee.userId,
        operationId,
        fee.holdId,
        { kind: "release", amountMicros: 0 },
        tx,
      );
      await tx.query(
        `update gigachat_request_fees set state=$2,resolution_operation_id=$3,resolved_at=clock_timestamp()
 where hold_id=$1`,
        [fee.holdId, outcome, operationId],
      );
    }
    // Errors are free to the customer. Unknown remote execution still occupies
    // provider capacity until the conservative deadline; no blind model retry.
    await tx.query(
      `update gigachat_account_leases set lease_token=null,hold_id=null,expires_at=null
 where account_ref=$1 and hold_id=$2 and lease_token=$3 and expires_at<=clock_timestamp()`,
      [fee.accountRef, fee.holdId, fee.leaseToken],
    );
  }
  async recoverExpired(input: { limit?: number } = {}) {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new DomainError(400, "Некорректный размер проверки");
    const candidates = await this.db.query<{
      user_id: string;
      hold_id: string;
    }>(
      `select f.user_id::text,f.hold_id::text from gigachat_request_fees f join gigachat_account_leases l
 on l.hold_id=f.hold_id and l.lease_token=f.lease_token where l.expires_at<=clock_timestamp()
 and f.state in ('reserved','dispatched','failed') order by l.expires_at,f.hold_id limit $1`,
      [limit],
    );
    let released = 0,
      cleared = 0;
    for (const row of candidates.rows)
      await this.db.transaction(async (tx) => {
        await this.lockAccount(tx, row.user_id);
        const fee = await this.get(row.user_id, row.hold_id, tx, true);
        const expired = await tx.query(
          "select 1 from gigachat_account_leases where hold_id=$1 and lease_token=$2 and expires_at<=clock_timestamp() for update",
          [fee.holdId, fee.leaseToken],
        );
        if (
          !expired.rows.length ||
          fee.state === "succeeded" ||
          fee.state === "expired"
        )
          return;
        const pending = fee.state === "reserved" || fee.state === "dispatched";
        await this.releaseFailure(tx, fee, "expired");
        await tx.query(
          "update chat_requests set status='interrupted' where thread_id=$1 and request_id=$2 and status='running'",
          [fee.threadId, fee.requestId],
        );
        await tx.query(
          "update agent_threads set busy_until=null,lease_token=null where id=$1 and user_id=$2 and lease_token=$3",
          [fee.threadId, fee.userId, fee.chatLease],
        );
        if (pending) released++;
        cleared++;
      });
    return { examined: candidates.rows.length, released, cleared };
  }
}

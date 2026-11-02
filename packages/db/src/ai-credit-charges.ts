import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  creditGenerationIdSchema,
  routerAiChargeSchema,
  LEGACY_AT_COST_TARIFF,
  citygoTariffSnapshotSchema,
  reserveCitygoMicros,
  citygoDebitFromRealCostRub,
  type CityGoTariffSnapshot,
  type RouterAiCharge,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import {
  captureBalanceCostLimit,
  type AiRequestCostLimitMode,
} from "./request-cost-limit.js";
import { AiCreditLedger } from "./ai-credit.js";
import { DomainError } from "./errors.js";
import {
  FIXED_CITYGO_HOLD_MICROS,
  MAX_OVERDRAFT_REAL_CEILING_MICROS,
  type AiCreditReservationMode,
} from "./credit-debt.js";
export type { AiCreditReservationMode } from "./credit-debt.js";

function decimalWithinCeiling(costRub: string, realCeilingMicros: number) {
  // The receipt schema has already bounded this grammar and the exponent.
  const match = /^(\d{1,13})(?:\.(\d{1,30}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(
    costRub,
  )!;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) + 6 - fraction.length;
  const digits = BigInt(match[1]! + fraction);
  return exponent >= 0
    ? digits * 10n ** BigInt(exponent) <= BigInt(realCeilingMicros)
    : digits <= BigInt(realCeilingMicros) * 10n ** BigInt(-exponent);
}

type Charge = {
  hold_id: string;
  user_id: string;
  model: string;
  upstream: string;
  generation_id: string | null;
  dispatched: boolean;
  response_complete: boolean;
  receipt: RouterAiCharge | null;
  amount_micros: string;
  tariff_snapshot: CityGoTariffSnapshot;
  real_ceiling_micros: string;
  reservation_mode: AiCreditReservationMode;
  cost_limit_mode: AiRequestCostLimitMode;
  balance_before_hold_micros: string | null;
};
export class AiCreditCharges {
  private ledger: AiCreditLedger;
  private tariff: CityGoTariffSnapshot;
  constructor(
    private db: Database,
    tariffSnapshot: CityGoTariffSnapshot = LEGACY_AT_COST_TARIFF,
    private reservationMode: AiCreditReservationMode = "full",
    private requestCostLimitMode: AiRequestCostLimitMode = "operator_ceiling",
  ) {
    this.tariff = Object.freeze(
      citygoTariffSnapshotSchema.parse(tariffSnapshot),
    );
    if (
      !["full", "fixed5_overdraft"].includes(reservationMode) ||
      (reservationMode === "fixed5_overdraft" &&
        this.tariff.version !== "citygo-10x-v1")
    )
      throw new Error("Fixed5 overdraft requires the exact CityGo 10x tariff");
    if (
      !["operator_ceiling", "user_balance"].includes(requestCostLimitMode) ||
      (requestCostLimitMode === "user_balance" &&
        reservationMode !== "fixed5_overdraft")
    )
      throw new Error(
        "User balance cost limits require fixed5 CityGo 10x charging",
      );
    this.ledger = new AiCreditLedger(
      db,
      "not_connected",
      false,
      reservationMode,
      false,
      requestCostLimitMode,
    );
  }

  async reserve(
    tx: Sql,
    input: {
      userId: string;
      threadId: string;
      requestId: string;
      model: string;
      upstream: string;
    },
    amount: number,
  ) {
    if (
      this.reservationMode === "fixed5_overdraft" &&
      this.requestCostLimitMode === "operator_ceiling" &&
      (!Number.isSafeInteger(amount) ||
        amount < 500_000 ||
        amount > MAX_OVERDRAFT_REAL_CEILING_MICROS)
    )
      throw new DomainError(
        409,
        "Потолок fixed5 должен быть от 0,5 до 6 реальных ₽",
      );
    const balance =
      this.requestCostLimitMode === "user_balance"
        ? await captureBalanceCostLimit(tx, input.userId)
        : null;
    if (balance && amount !== balance.realCeilingMicros)
      throw new DomainError(
        409,
        "Лимит запроса не соответствует доступному балансу CityGo",
      );
    const id = randomUUID();
    await this.ledger.hold(
      input.userId,
      id,
      this.reservationMode === "fixed5_overdraft"
        ? FIXED_CITYGO_HOLD_MICROS
        : reserveCitygoMicros(amount, this.tariff),
      tx,
    );
    await tx.query(
      `insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,tariff_snapshot,real_ceiling_micros,reservation_mode,cost_limit_mode,balance_before_hold_micros)
      values ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        input.userId,
        input.threadId,
        input.requestId,
        input.model,
        input.upstream,
        JSON.stringify(this.tariff),
        amount,
        this.reservationMode,
        this.requestCostLimitMode,
        balance?.balanceBeforeHoldMicros ?? null,
      ],
    );
    return id;
  }
  // Read-only keyset page: never lease a legacy hold or keep a DB lock while
  // waiting on its provider GET. Existing ledger resolution remains atomic.
  async completedUnresolvedAfter(after?: string, limit = 20) {
    const cursor = after === undefined ? null : z.uuid().parse(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error("Invalid legacy charge page limit");
    return (
      await this.db.query<{ holdId: string; userId: string }>(
        `select c.hold_id::text as "holdId",c.user_id::text as "userId"
       from ai_credit_charges c join ai_credit_entries h
         on h.operation_id=c.hold_id and h.user_id=c.user_id and h.kind='hold'
       where c.dispatched and c.response_complete and c.generation_id is not null and c.receipt is null
         and ($1::uuid is null or c.hold_id>$1::uuid)
         and not exists(select 1 from ai_credit_entries done where done.hold_id=c.hold_id)
         and not exists(select 1 from audit_log a where a.action='ai-credit-cost-overrun'
           and a.entity_type='ai-credit' and lower(a.entity_id)=c.hold_id::text)
       order by c.hold_id limit $2`,
        [cursor, limit],
      )
    ).rows;
  }
  async get(userId: string, id: string, tx: Sql = this.db): Promise<Charge> {
    const result = await tx.query<Charge>(
      `select c.*,c.user_id::text,e.amount_micros::text,
       coalesce(c.real_ceiling_micros,e.amount_micros)::text as real_ceiling_micros
      from ai_credit_charges c join ai_credit_entries e on e.operation_id=c.hold_id where c.hold_id=$1 and c.user_id=$2`,
      [id, userId],
    );
    if (!result.rows[0]) throw new DomainError(404, "Резерв запроса не найден");
    return result.rows[0];
  }
  private async locked(tx: Sql, userId: string, id: string) {
    await tx.query("select id from users where id=$1 for update", [userId]);
    await tx.query(
      "select user_id from ai_credit_accounts where user_id=$1 for update",
      [userId],
    );
    await tx.query(
      "select hold_id from ai_credit_charges where hold_id=$1 and user_id=$2 for update",
      [id, userId],
    );
    return this.get(userId, id, tx);
  }
  async dispatch(userId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, userId, id);
      const resolved = await tx.query(
        "select id from ai_credit_entries where hold_id=$1",
        [id],
      );
      if (row.dispatched || resolved.rows.length)
        throw new DomainError(409, "Повторный вызов модели запрещён");
      await tx.query(
        "update ai_credit_charges set dispatched=true where hold_id=$1",
        [id],
      );
    });
  }
  async identify(userId: string, id: string, generationId: string) {
    creditGenerationIdSchema.parse(generationId);
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, userId, id);
      if (
        !row.dispatched ||
        (row.generation_id && row.generation_id !== generationId)
      )
        throw new DomainError(
          409,
          "Идентификатор генерации не соответствует резерву",
        );
      await tx.query(
        "update ai_credit_charges set generation_id=$2 where hold_id=$1",
        [id, generationId],
      );
    });
  }
  // Only the in-process caller can prove it never entered the adapter. A crash,
  // HTTP error, timeout or lack of a generation ID is NOT such proof.
  async releaseBeforeTransport(userId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, userId, id);
      if (row.generation_id || row.response_complete || row.receipt)
        throw new DomainError(409, "Резерв требует сверки");
      const previous = await tx.query(
        "select kind from ai_credit_entries where hold_id=$1",
        [id],
      );
      if (previous.rows[0]?.kind === "release") return;
      await this.ledger.resolve(
        userId,
        randomUUID(),
        id,
        { kind: "release", amountMicros: 0 },
        tx,
      );
    });
  }
  async settle(userId: string, id: string, raw: RouterAiCharge) {
    await this.settleReceipt(userId, id, raw, false);
  }
  // Background recovery is a STRICT SUBSET of the original explicit path:
  // positive known cost within the original accepted ceiling, no manual state.
  async settleCompletedAutomatically(
    userId: string,
    id: string,
    raw: RouterAiCharge,
  ) {
    return this.settleReceipt(userId, id, raw, true);
  }
  private async settleReceipt(
    userId: string,
    id: string,
    raw: RouterAiCharge,
    automatic: boolean,
  ) {
    const receipt = routerAiChargeSchema.parse(raw);
    const outcome = await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, userId, id);
      if (
        !row.response_complete ||
        row.generation_id !== receipt.generationId ||
        receipt.reference !== id ||
        receipt.model !== row.model ||
        receipt.upstream !== row.upstream
      )
        throw new DomainError(
          409,
          "Стоимость не соответствует завершённой попытке",
        );
      // Provider GET zero has no finality proof. Never turn it into a new free
      // legacy settlement, and never change the old explicit zero semantics.
      if (automatic && Number(receipt.costRub) === 0) return "pending";
      if (row.receipt) {
        if (
          row.receipt.costRub !== receipt.costRub ||
          row.receipt.amountMicros !== receipt.amountMicros
        )
          throw new DomainError(409, "Подтверждённая стоимость изменилась");
        return "settled";
      }
      // Replay uses the attempt's durable tariff, never this process's current
      // default. Scale the original decimal before rounding; provider cost and
      // receipt remain real RUB, not CityGo balance units.
      const tariff = citygoTariffSnapshotSchema.parse(row.tariff_snapshot);
      const { citygoDebitMicros } = citygoDebitFromRealCostRub(
        receipt.costRub,
        tariff,
      );
      // Compare exact decimals as well: flooring the real receipt could hide a
      // cost just above the accepted ceiling, even when the debit still fits.
      const exactWithinCeiling = decimalWithinCeiling(
        receipt.costRub,
        Number(row.real_ceiling_micros),
      );
      if (automatic) {
        const manual = await tx.query(
          "select 1 from audit_log where action='ai-credit-cost-overrun' and entity_type='ai-credit' and lower(entity_id)=lower($1) limit 1",
          [id],
        );
        if (
          !exactWithinCeiling ||
          manual.rows.length ||
          ((row.reservation_mode ?? "full") === "full" &&
            citygoDebitMicros > Number(row.amount_micros))
        )
          return "pending";
      }
      if (
        (row.cost_limit_mode !== "user_balance" && !exactWithinCeiling) ||
        ((row.reservation_mode ?? "full") === "full" &&
          citygoDebitMicros > Number(row.amount_micros))
      ) {
        // Legacy full/fixed5 reservations keep their accepted ceiling and
        // manual overrun stop. A balance-marked row is settled below using its
        // actual exact receipt; neither path guesses an unknown cost.
        await tx.query(
          "update ai_budget set enabled=false,revision=revision+1 where id=1 and enabled",
        );
        await tx.query(
          "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'ai-credit-cost-overrun','ai-credit',$2,$3)",
          [
            userId,
            id,
            JSON.stringify({
              amountMicros: receipt.amountMicros,
              reservedMicros: Number(row.amount_micros),
              citygoDebitMicros,
              realCeilingMicros: Number(row.real_ceiling_micros),
            }),
          ],
        );
        return "overrun";
      }
      if (row.cost_limit_mode === "user_balance" && !exactWithinCeiling)
        await tx.query(
          "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'ai-credit-balance-limit-exceeded','ai-credit',$2,$3)",
          [
            userId,
            id,
            JSON.stringify({
              balanceBeforeHoldMicros: Number(row.balance_before_hold_micros),
              realCeilingMicros: Number(row.real_ceiling_micros),
              actualCostRub: receipt.costRub,
              citygoDebitMicros,
              resolution: "exact_actual_settlement",
              budgetDisabled: false,
            }),
          ],
        );
      if (row.reservation_mode === "fixed5_overdraft")
        await tx.query(
          "update ai_credit_charges set receipt=$2 where hold_id=$1",
          [id, JSON.stringify(receipt)],
        );
      await this.ledger.resolve(
        userId,
        randomUUID(),
        id,
        { kind: "settle", amountMicros: citygoDebitMicros },
        tx,
      );
      await tx.query(
        "update ai_credit_charges set receipt=$2 where hold_id=$1",
        [id, JSON.stringify(receipt)],
      );
      return "settled";
    });
    if (outcome === "overrun")
      throw new DomainError(
        409,
        "Стоимость превысила резерв. AI остановлен до проверки администратором.",
      );
    return outcome === "settled";
  }
}

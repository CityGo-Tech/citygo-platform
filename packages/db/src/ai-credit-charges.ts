import { randomUUID } from "node:crypto";
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
import { AiCreditLedger } from "./ai-credit.js";
import { DomainError } from "./errors.js";

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
};
export class AiCreditCharges {
  private ledger: AiCreditLedger;
  private tariff: CityGoTariffSnapshot;
  constructor(
    private db: Database,
    tariffSnapshot: CityGoTariffSnapshot = LEGACY_AT_COST_TARIFF,
  ) {
    this.ledger = new AiCreditLedger(db);
    this.tariff = Object.freeze(
      citygoTariffSnapshotSchema.parse(tariffSnapshot),
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
    const id = randomUUID();
    await this.ledger.hold(
      input.userId,
      id,
      reserveCitygoMicros(amount, this.tariff),
      tx,
    );
    await tx.query(
      `insert into ai_credit_charges(hold_id,user_id,thread_id,request_id,attempt_number,model,upstream,tariff_snapshot,real_ceiling_micros)
      values ($1,$2,$3,$4,1,$5,$6,$7,$8)`,
      [
        id,
        input.userId,
        input.threadId,
        input.requestId,
        input.model,
        input.upstream,
        JSON.stringify(this.tariff),
        amount,
      ],
    );
    return id;
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
    const receipt = routerAiChargeSchema.parse(raw);
    const overrun = await this.db.transaction(async (tx) => {
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
      if (row.receipt) {
        if (
          row.receipt.costRub !== receipt.costRub ||
          row.receipt.amountMicros !== receipt.amountMicros
        )
          throw new DomainError(409, "Подтверждённая стоимость изменилась");
        return false;
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
      if (
        !exactWithinCeiling ||
        citygoDebitMicros > Number(row.amount_micros)
      ) {
        // Never charge more than the accepted hold. Stop future spend pending
        // operator review; the operator ceiling remains conservative, not billed.
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
        return true;
      }
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
      return false;
    });
    if (overrun)
      throw new DomainError(
        409,
        "Стоимость превысила резерв. AI остановлен до проверки администратором.",
      );
  }
}

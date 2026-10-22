import { z } from "zod";
import {
  CITYGO_MAX_AMOUNT_MICROS,
  creditUserIdSchema,
  citygoTopUpMicrosFromPaidKopeks,
} from "@citygo/contracts";
import type { Sql } from "./index.js";
import { DomainError } from "./errors.js";
import { assertCreditDebtPaid, repayCreditDebt } from "./credit-debt.js";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const money = z.number().int().min(0).max(CITYGO_MAX_AMOUNT_MICROS);
const kopeks = z.number().int().min(1).max(1_000_000_000);
type Lot = {
  id: string;
  user_id: string;
  kind: "gift" | "paid" | "legacy_nonrefundable";
  paid_operation_id: string | null;
  provider_payment_id: string | null;
  merchant_id: string | null;
  test: boolean | null;
  gross_micros: string;
  spent_micros: string;
  held_micros: string;
  refund_reserved_micros: string;
  refunded_micros: string;
  created_at: string;
};
export type PaidSourceLot = {
  id: string;
  userId: string;
  sourceOperationId: string;
  providerPaymentId: string;
  merchantId: string;
  test: boolean;
  grossMicros: number;
  availableMicros: number;
  spentMicros: number;
  heldMicros: number;
  refundReservedMicros: number;
  refundedMicros: number;
  createdAt: string;
};
export type PaidRefundAllocation = {
  refundId: string;
  userId: string;
  sourceOperationId: string;
  providerPaymentId: string;
  merchantId: string;
  test: boolean;
  amountKopeks: number;
  refundedBeforeKopeks: number;
  state: "reserved" | "settled" | "released";
};
const selectLot = `id,user_id::text,kind,paid_operation_id,provider_payment_id,merchant_id,test,gross_micros::text,spent_micros::text,held_micros::text,refund_reserved_micros::text,refunded_micros::text,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError(400, "Некорректная операция источников баланса");
  return result.data;
}
function available(lot: Lot) {
  return (
    Number(lot.gross_micros) -
    Number(lot.spent_micros) -
    Number(lot.held_micros) -
    Number(lot.refund_reserved_micros) -
    Number(lot.refunded_micros)
  );
}
function paid(lot: Lot): PaidSourceLot {
  if (
    lot.kind !== "paid" ||
    !lot.paid_operation_id ||
    !lot.provider_payment_id ||
    !lot.merchant_id ||
    lot.test === null
  )
    throw new DomainError(
      409,
      "Для возврата нужен отдельный подтверждённый оплаченный источник",
    );
  return {
    id: lot.id,
    userId: lot.user_id,
    sourceOperationId: lot.paid_operation_id,
    providerPaymentId: lot.provider_payment_id,
    merchantId: lot.merchant_id,
    test: lot.test,
    grossMicros: Number(lot.gross_micros),
    availableMicros: available(lot),
    spentMicros: Number(lot.spent_micros),
    heldMicros: Number(lot.held_micros),
    refundReservedMicros: Number(lot.refund_reserved_micros),
    refundedMicros: Number(lot.refunded_micros),
    createdAt: lot.created_at,
  };
}
async function usable(sql: Sql, userId: string) {
  const row = (
    await sql.query<{ billing_review_required: boolean }>(
      "select billing_review_required from ai_credit_accounts where user_id=$1",
      [userId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, "Счёт баланса не найден");
  if (row.billing_review_required)
    throw new DomainError(
      409,
      "Баланс требует сверки; новые денежные резервы запрещены",
    );
}
export async function listPaidSourceLots(
  sql: Sql,
  userId: string,
): Promise<PaidSourceLot[]> {
  input(creditUserIdSchema, userId);
  return (
    await sql.query<Lot>(
      `select ${selectLot} from credit_source_lots where user_id=$1 and kind='paid' order by source_entry_id,id limit 101`,
      [userId],
    )
  ).rows.map(paid);
}

// Callers hold security -> users -> credit account locks. Only the source rows
// are additionally locked here; no helper opens a nested transaction or network.
// Gift first, then conservative non-refundable historical funds, then paid FIFO.
export async function reserveCreditSources(
  tx: Sql,
  userId: string,
  holdId: string,
  amountMicros: number,
) {
  input(creditUserIdSchema, userId);
  holdId = input(uuid, holdId);
  input(money.positive(), amountMicros);
  const posting = (
    await tx.query<{ user_id: string; amount_micros: string; kind: string }>(
      "select user_id::text,amount_micros::text,kind from ai_credit_entries where operation_id=$1",
      [holdId],
    )
  ).rows[0];
  if (
    !posting ||
    posting.user_id !== userId ||
    posting.kind !== "hold" ||
    Number(posting.amount_micros) !== amountMicros
  )
    throw new DomainError(
      409,
      "Резерв источников не соответствует исходной операции AI",
    );
  await usable(tx, userId);
  await assertCreditDebtPaid(tx, userId);
  const previous = (
    await tx.query<{ amount: string }>(
      "select sum(reserved_micros)::text as amount from credit_hold_allocations where hold_id=$1",
      [holdId],
    )
  ).rows[0];
  if (previous?.amount !== null && previous?.amount !== undefined) {
    if (Number(previous.amount) === amountMicros) return;
    throw new DomainError(409, "Резерв источников уже создан с другой суммой");
  }
  const lots = (
    await tx.query<Lot>(
      `select ${selectLot} from credit_source_lots where user_id=$1
    and gross_micros>spent_micros+held_micros+refund_reserved_micros+refunded_micros
    order by case kind when 'gift' then 0 when 'legacy_nonrefundable' then 1 else 2 end,source_entry_id nulls first,id for update`,
      [userId],
    )
  ).rows;
  if (lots.reduce((sum, lot) => sum + available(lot), 0) < amountMicros)
    throw new DomainError(
      409,
      "Недостаточно свободных источников баланса для резерва",
    );
  let remaining = amountMicros,
    ordinal = 0;
  for (const lot of lots) {
    const amount = Math.min(remaining, available(lot));
    if (amount <= 0) continue;
    await tx.query(
      "update credit_source_lots set held_micros=held_micros+$2 where id=$1",
      [lot.id, amount],
    );
    await tx.query(
      "insert into credit_hold_allocations(hold_id,source_lot_id,ordinal,reserved_micros) values($1,$2,$3,$4)",
      [holdId, lot.id, ordinal++, amount],
    );
    remaining -= amount;
    if (remaining === 0) break;
  }
}
export async function resolveCreditSources(
  tx: Sql,
  userId: string,
  holdId: string,
  resolution: { kind: "settle" | "release"; amountMicros: number },
) {
  input(creditUserIdSchema, userId);
  holdId = input(uuid, holdId);
  input(money, resolution.amountMicros);
  if (
    !["settle", "release"].includes(resolution.kind) ||
    (resolution.kind === "release" && resolution.amountMicros !== 0)
  )
    throw new DomainError(400, "Некорректное завершение резерва источников");
  const rows = (
    await tx.query<{
      source_lot_id: string;
      reserved_micros: string;
      spent_micros: string;
      state: string;
    }>(
      `select a.source_lot_id,a.reserved_micros::text,a.spent_micros::text,a.state from credit_hold_allocations a
    join credit_source_lots l on l.id=a.source_lot_id where a.hold_id=$1 and l.user_id=$2 order by a.ordinal for update of a,l`,
      [holdId, userId],
    )
  ).rows;
  if (!rows.length)
    throw new DomainError(
      409,
      "Исторический резерв не привязан к источникам; нужна сверка",
    );
  const state = resolution.kind === "settle" ? "settled" : "released";
  if (
    rows.every((row) => row.state === state) &&
    rows.reduce((sum, row) => sum + Number(row.spent_micros), 0) ===
      resolution.amountMicros
  )
    return;
  if (
    rows.some((row) => row.state !== "reserved") ||
    rows.reduce((sum, row) => sum + Number(row.reserved_micros), 0) <
      resolution.amountMicros
  )
    throw new DomainError(
      409,
      "Резерв источников уже завершён либо сумма превышена",
    );
  let remaining = resolution.amountMicros;
  for (const row of rows) {
    const spent = Math.min(remaining, Number(row.reserved_micros));
    remaining -= spent;
    await tx.query(
      "update credit_source_lots set held_micros=held_micros-$2,spent_micros=spent_micros+$3 where id=$1",
      [row.source_lot_id, Number(row.reserved_micros), spent],
    );
    await tx.query(
      "update credit_hold_allocations set state=$3,spent_micros=$4 where hold_id=$1 and source_lot_id=$2",
      [holdId, row.source_lot_id, state, spent],
    );
  }
}

async function allocation(
  tx: Sql,
  userId: string,
  refundId: string,
): Promise<PaidRefundAllocation | undefined> {
  const row = (
    await tx.query<{
      refund_id: string;
      user_id: string;
      source_operation_id: string;
      provider_payment_id: string;
      merchant_id: string;
      test: boolean;
      amount_kopeks: string;
      refunded_before_kopeks: string;
      state: PaidRefundAllocation["state"];
    }>(
      `select r.refund_id,r.user_id::text,l.paid_operation_id as source_operation_id,l.provider_payment_id,l.merchant_id,l.test,
      (r.amount_micros/10000)::text as amount_kopeks,r.refunded_before_kopeks::text,r.state
      from credit_refund_allocations r join credit_source_lots l on l.id=r.source_lot_id where r.refund_id=$1 for update of r`,
      [refundId],
    )
  ).rows[0];
  if (!row) return;
  if (row.user_id !== userId)
    throw new DomainError(409, "Резерв возврата принадлежит другому счёту");
  return {
    refundId: row.refund_id,
    userId: row.user_id,
    sourceOperationId: row.source_operation_id,
    providerPaymentId: row.provider_payment_id,
    merchantId: row.merchant_id,
    test: row.test,
    amountKopeks: Number(row.amount_kopeks),
    refundedBeforeKopeks: Number(row.refunded_before_kopeks),
    state: row.state,
  };
}
export async function reservePaidRefund(
  tx: Sql,
  userId: string,
  sourceOperationId: string,
  refundId: string,
  amountKopeks: number,
): Promise<PaidRefundAllocation> {
  input(creditUserIdSchema, userId);
  sourceOperationId = input(uuid, sourceOperationId);
  refundId = input(uuid, refundId);
  input(kopeks, amountKopeks);
  const previous = await allocation(tx, userId, refundId);
  if (previous) {
    if (
      previous.sourceOperationId !== sourceOperationId ||
      previous.amountKopeks !== amountKopeks
    )
      throw new DomainError(
        409,
        "ID возврата уже связан с другими параметрами",
      );
    return previous;
  }
  await usable(tx, userId);
  await assertCreditDebtPaid(tx, userId);
  const lot = (
    await tx.query<Lot>(
      `select ${selectLot} from credit_source_lots where paid_operation_id=$1 and user_id=$2 for update`,
      [sourceOperationId, userId],
    )
  ).rows[0];
  if (!lot)
    throw new DomainError(
      409,
      "Подарок и исторические средства не подлежат возврату",
    );
  paid(lot);
  const amount = citygoTopUpMicrosFromPaidKopeks(amountKopeks);
  if (available(lot) < amount)
    throw new DomainError(
      409,
      "Оплаченные средства уже потрачены, зарезервированы или возвращены",
    );
  if (
    (
      await tx.query(
        "select refund_id from credit_refund_allocations where source_lot_id=$1 and state='reserved'",
        [lot.id],
      )
    ).rows.length
  )
    throw new DomainError(
      409,
      "У этого платежа уже есть незавершённый возврат",
    );
  const updated = await tx.query(
    "update ai_credit_accounts set held_micros=held_micros+$2 where user_id=$1 and granted_micros-held_micros-spent_micros>=$2 returning user_id",
    [userId, amount],
  );
  if (!updated.rows.length)
    throw new DomainError(409, "Недостаточно доступного баланса для возврата");
  await tx.query(
    "update credit_source_lots set refund_reserved_micros=refund_reserved_micros+$2 where id=$1",
    [lot.id, amount],
  );
  await tx.query(
    "insert into credit_refund_allocations(refund_id,user_id,source_lot_id,amount_micros,refunded_before_kopeks) values($1,$2,$3,$4,$5)",
    [refundId, userId, lot.id, amount, Number(lot.refunded_micros) / 10000],
  );
  return (await allocation(tx, userId, refundId))!;
}
async function resolvePaidRefund(
  tx: Sql,
  userId: string,
  refundId: string,
  state: "settled" | "released",
): Promise<PaidRefundAllocation> {
  input(creditUserIdSchema, userId);
  refundId = input(uuid, refundId);
  const previous = await allocation(tx, userId, refundId);
  if (!previous) throw new DomainError(404, "Резерв возврата не найден");
  if (previous.state === state) return previous;
  if (previous.state !== "reserved")
    throw new DomainError(409, "Возврат уже завершён другим способом");
  const amount = citygoTopUpMicrosFromPaidKopeks(previous.amountKopeks);
  const lot = (
    await tx.query<{ id: string }>(
      "select id from credit_source_lots where paid_operation_id=$1 and user_id=$2 for update",
      [previous.sourceOperationId, userId],
    )
  ).rows[0];
  if (!lot)
    throw new DomainError(409, "Оплаченный источник возврата не найден");
  await tx.query(
    "update credit_source_lots set refund_reserved_micros=refund_reserved_micros-$2,refunded_micros=refunded_micros+$3 where id=$1",
    [lot.id, amount, state === "settled" ? amount : 0],
  );
  await tx.query(
    "update ai_credit_accounts set held_micros=held_micros-$2,granted_micros=granted_micros-$3 where user_id=$1",
    [userId, amount, state === "settled" ? amount : 0],
  );
  await tx.query(
    "update credit_refund_allocations set state=$2 where refund_id=$1",
    [refundId, state],
  );
  await repayCreditDebt(tx, userId);
  return { ...previous, state };
}
export function settlePaidRefund(tx: Sql, userId: string, refundId: string) {
  return resolvePaidRefund(tx, userId, refundId, "settled");
}
export function releasePaidRefund(tx: Sql, userId: string, refundId: string) {
  return resolvePaidRefund(tx, userId, refundId, "released");
}

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  adminNpdReceiptDetailSchema,
  adminNpdReceiptListSchema,
  adminNpdReceiptTaskSchema,
  creditUserIdSchema,
  npdReceiptCommandSchema,
  npdReceiptListQuerySchema,
  npdReceiptTaskIdSchema,
  ownerNpdReceiptListSchema,
  ownerNpdReceiptTaskSchema,
  type AdminNpdReceiptTask,
  type NpdReceiptCommand,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

export type NpdReceiptContext = { userId: string; sessionTokenHash: string };
const ctxSchema = z.strictObject({
  userId: creditUserIdSchema,
  sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const refundSchema = z.strictObject({
  userId: creditUserIdSchema,
  providerPaymentId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  providerRefundId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  merchantId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  amountKopeks: z.number().int().min(1).max(1_000_000_000),
  currency: z.literal("RUB"),
  test: z.literal(false),
  status: z.literal("succeeded"),
  verification: z.literal("server_get_succeeded"),
  observedAt: z.iso.datetime(),
});
export type NpdConfirmedRefundObservation = z.infer<typeof refundSchema>;
const stamp = (field: string) =>
  `to_char(${field} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const selection = `t.id,t.user_id::text as "userId",t.payment_id as "paymentId",t.payment_provider as "paymentProvider",
 t.amount_kopeks::integer as "amountKopeks",t.cumulative_refunded_kopeks::integer as "cumulativeRefundedKopeks",
 (t.amount_kopeks-t.cumulative_refunded_kopeks)::integer as "remainingIncomeKopeks",t.revision,
 t.buyer_email as "buyerEmail",t.claimed_by_user_id::text as "claimedByUserId",
 t.registration_status as "registrationStatus",t.delivery_status as "deliveryStatus",t.correction_status as "correctionStatus",
 t.active_evidence_id as "activeEvidenceId",e.receipt_id as "activeReceiptId",coalesce(e.receipt_url,e.evidence_url) as "activeReceiptUrl",
 t.review_reason as "reviewReason",${stamp("t.observed_at")} as "observedAt",${stamp("t.created_at")} as "createdAt",${stamp("t.updated_at")} as "updatedAt"`;
const from =
  "from npd_receipt_tasks t left join npd_receipt_evidence e on e.id=t.active_evidence_id and e.task_id=t.id";
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError(400, "Некорректная команда реестра чеков");
  return result.data;
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error("Stored NPD receipt data requires operator review");
  return result.data;
}

// Operator reports only. No network, money posting, FNS verification or receipt
// generation. A claim is never silently stolen, including after role revocation:
// recovery needs a separate explicit handoff and review of outside actions.
export class NpdReceipts {
  constructor(private db: Database) {}

  private async authorize(tx: Sql, raw: NpdReceiptContext, admin: boolean) {
    const ctx = parse(ctxSchema, raw);
    const security = await tx.query(
      "select id from account_security_state where id=1 for update",
    );
    if (!security.rows.length)
      throw new DomainError(503, "Состояние доступа к реестру не готово");
    await tx.query("select id from users where id=$1 for update", [ctx.userId]);
    const current = (
      await tx.query<{ role: string; must_change_password: boolean }>(
        `select u.role,u.must_change_password from sessions s join users u on u.id=s.user_id
       where s.token_hash=$1 and s.user_id=$2 and s.expires_at>clock_timestamp()
       and u.status='active' for update of s`,
        [ctx.sessionTokenHash, ctx.userId],
      )
    ).rows[0];
    if (!current) throw new DomainError(401, "Войдите в аккаунт");
    if (
      current.must_change_password ||
      (admin && !["admin", "super_admin"].includes(current.role))
    )
      throw new DomainError(
        403,
        "Нужны актуальные права оператора и смена временного пароля",
      );
    return ctx;
  }
  private async read(tx: Sql, id: string) {
    const task = (
      await tx.query<AdminNpdReceiptTask>(
        `select ${selection} ${from} where t.id=$1`,
        [id],
      )
    ).rows[0];
    if (!task) throw new DomainError(404, "Задание чека не найдено");
    return stored(adminNpdReceiptTaskSchema, task);
  }
  private async locked(tx: Sql, id: string) {
    parse(npdReceiptTaskIdSchema, id);
    await tx.query("select id from npd_receipt_tasks where id=$1 for update", [
      id,
    ]);
    return this.read(tx, id);
  }
  private async detail(tx: Sql, id: string) {
    const task = await this.read(tx, id);
    const events = (
      await tx.query(
        `
      select * from (
        select request_id as "requestId",action,actor_user_id::text as "actorUserId",result_revision as revision,payload,${stamp("created_at")} as "createdAt"
          from npd_receipt_commands where task_id=$1
        union all
        select r.id,'refund_observed',null,r.result_revision,
          jsonb_build_object('action','refund_observed','providerRefundId',r.provider_refund_id,'amountKopeks',r.amount_kopeks,
            'cumulativeRefundedKopeks',(select sum(r2.amount_kopeks) from npd_refund_observations r2 where r2.task_id=r.task_id and r2.result_revision<=r.result_revision)),
          ${stamp("r.created_at")} from npd_refund_observations r where r.task_id=$1
      ) history order by revision desc limit 200`,
        [id],
      )
    ).rows;
    return stored(adminNpdReceiptDetailSchema, { task, events });
  }

  async listAdmin(ctx: NpdReceiptContext, raw: unknown = {}) {
    const query = parse(npdReceiptListQuerySchema, raw);
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, ctx, true);
      if (
        query.after &&
        !(
          await tx.query("select id from npd_receipt_tasks where id=$1", [
            query.after,
          ])
        ).rows.length
      )
        throw new DomainError(404, "Курсор очереди не найден");
      const tasks = (
        await tx.query<AdminNpdReceiptTask>(
          `select ${selection} ${from}
        where ($1::uuid is null or (t.created_at,t.id)<(select created_at,id from npd_receipt_tasks where id=$1))
        and ($2::text is null or
          ($2='review' and t.review_reason is not null) or
          ($2='correction_required' and t.correction_status='required' and t.review_reason is null) or
          ($2='pending' and t.registration_status='pending' and t.correction_status<>'required' and t.review_reason is null) or
          ($2='registered' and t.registration_status='operator_reported' and t.correction_status<>'required' and t.review_reason is null))
        order by t.created_at desc,t.id desc limit $3`,
          [query.after ?? null, query.status ?? null, query.limit + 1],
        )
      ).rows;
      return stored(adminNpdReceiptListSchema, {
        tasks: tasks.slice(0, query.limit),
        nextAfter:
          tasks.length > query.limit ? tasks[query.limit - 1]!.id : null,
      });
    });
  }
  async detailAdmin(ctx: NpdReceiptContext, id: string) {
    id = parse(npdReceiptTaskIdSchema, id);
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, ctx, true);
      return this.detail(tx, id);
    });
  }
  async listOwner(ctx: NpdReceiptContext) {
    return this.db.transaction(async (tx) => {
      const owner = await this.authorize(tx, ctx, false);
      const rows = (
        await tx.query<AdminNpdReceiptTask>(
          `select ${selection} ${from} where t.user_id=$1 order by t.created_at desc,t.id desc limit 100`,
          [owner.userId],
        )
      ).rows;
      return stored(ownerNpdReceiptListSchema, {
        tasks: rows.map((row) => {
          const projection: Record<string, unknown> = { ...row };
          delete projection.buyerEmail;
          delete projection.claimedByUserId;
          return stored(ownerNpdReceiptTaskSchema, projection);
        }),
      });
    });
  }
  async command(ctx: NpdReceiptContext, id: string, raw: unknown) {
    id = parse(npdReceiptTaskIdSchema, id);
    const command = parse(npdReceiptCommandSchema, raw);
    try {
      return await this.db.transaction(async (tx) => {
        const actor = await this.authorize(tx, ctx, true);
        const task = await this.locked(tx, id);
        const previous = (
          await tx.query<{
            task_id: string;
            actor_user_id: string;
            payload: NpdReceiptCommand;
          }>(
            "select task_id,actor_user_id::text,payload from npd_receipt_commands where request_id=$1",
            [command.requestId],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.task_id !== id ||
            previous.actor_user_id !== actor.userId ||
            !isDeepStrictEqual(previous.payload, command)
          )
            throw new DomainError(
              409,
              "ID команды уже использован с другими параметрами",
            );
          return this.detail(tx, id);
        }
        if (
          task.revision !== command.expectedRevision ||
          task.revision === 2_147_483_647
        )
          throw new DomainError(
            409,
            "Задание изменилось. Обновите очередь и выполните сверку",
          );
        if (task.claimedByUserId && task.claimedByUserId !== actor.userId)
          throw new DomainError(
            409,
            "Задание закреплено за другим оператором; автоматический перехват запрещён",
          );
        if (command.action !== "claim" && task.claimedByUserId !== actor.userId)
          throw new DomainError(409, "Сначала закрепите за собой задание");
        if (
          command.action === "register" &&
          (task.registrationStatus !== "pending" ||
            command.amountKopeks !== task.amountKopeks)
        )
          throw new DomainError(
            409,
            "Исходный чек уже записан либо сумма отличается от полной оплаты без вычета комиссии",
          );
        if (
          command.action === "delivery" &&
          (command.receiptEvidenceId !== task.activeEvidenceId ||
            task.deliveryStatus === "operator_reported" ||
            task.correctionStatus === "required")
        )
          throw new DomainError(
            409,
            "Нужен актуальный записанный документ и отдельное подтверждение его передачи",
          );
        if (command.action === "correction") {
          if (
            task.correctionStatus !== "required" ||
            command.refundSnapshotKopeks !== task.cumulativeRefundedKopeks ||
            !task.activeReceiptId ||
            command.canceledReceiptId !== task.activeReceiptId
          )
            throw new DomainError(
              409,
              "Коррекция требует актуальной суммы возвратов и исходного документа",
            );
          if (
            task.remainingIncomeKopeks === 0
              ? command.replacement !== null
              : !command.replacement ||
                command.replacement.amountKopeks !==
                  task.remainingIncomeKopeks ||
                command.replacement.receiptId === command.canceledReceiptId
          )
            throw new DomainError(
              409,
              "Коррекция должна сохранить весь оставшийся доход",
            );
        }
        const revision = task.revision + 1;
        await tx.query(
          "insert into npd_receipt_commands(request_id,task_id,actor_user_id,action,payload,result_revision) values($1,$2,$3,$4,$5,$6)",
          [
            command.requestId,
            id,
            actor.userId,
            command.action,
            JSON.stringify(command),
            revision,
          ],
        );
        if (command.action === "register" || command.action === "correction") {
          const receipt =
            command.action === "register" ? command : command.replacement;
          await tx.query(
            `insert into npd_receipt_evidence(id,task_id,kind,receipt_id,receipt_url,amount_kopeks,evidence_url,refund_snapshot_kopeks)
            values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              command.requestId,
              id,
              command.action,
              receipt?.receiptId ?? null,
              receipt?.receiptUrl ?? null,
              receipt?.amountKopeks ?? 0,
              command.action === "register"
                ? command.receiptUrl
                : command.evidenceUrl,
              task.cumulativeRefundedKopeks,
            ],
          );
        }
        await tx.query(
          `update npd_receipt_tasks set revision=$2,updated_at=clock_timestamp(),
          claimed_by_user_id=case when $3='claim' then $4::bigint else claimed_by_user_id end,
          registration_status=case when $3='register' then 'operator_reported' else registration_status end,
          active_evidence_id=case when $3 in ('register','correction') then $5::uuid else active_evidence_id end,
          delivery_status=case when $3='delivery' then 'operator_reported' when $3 in ('register','correction') or ($3='review' and $6='delivery_uncertain') then 'pending' else delivery_status end,
          correction_status=case when $3='correction' then 'operator_reported' else correction_status end,
          review_reason=case when $3='review' then $6 when ($3='register' and review_reason='registration_uncertain')
            or ($3='delivery' and review_reason='delivery_uncertain') or ($3='correction' and review_reason='correction_uncertain') then null else review_reason end
          where id=$1`,
          [
            id,
            revision,
            command.action,
            actor.userId,
            command.requestId,
            command.action === "review" ? command.reason : null,
          ],
        );
        await tx.query(
          "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,$2,'npd-receipt',$3,$4)",
          [
            actor.userId,
            "npd-receipt-" + command.action,
            id,
            JSON.stringify({ requestId: command.requestId, revision }),
          ],
        );
        return this.detail(tx, id);
      });
    } catch (error) {
      return this.conflict(error);
    }
  }

  // TRUSTED SERVER ONLY. No public/admin route accepts this proof. Caller must
  // authenticate GET refund + original live YooKassa payment first. This records
  // a correction obligation only, never money or a legally proven refund date.
  async observeConfirmedRefund(
    raw: NpdConfirmedRefundObservation,
    transaction?: Sql,
  ) {
    const input = parse(refundSchema, raw);
    try {
      const work = async (tx: Sql) => {
        const security = await tx.query(
          "select id from account_security_state where id=1 for update",
        );
        if (!security.rows.length)
          throw new DomainError(503, "Состояние доступа к реестру не готово");
        await tx.query("select id from users where id=$1 for update", [
          input.userId,
        ]);
        const source = (
          await tx.query<{ id: string; merchant_id: string }>(
            "select id,merchant_id from npd_receipt_tasks where payment_id=$1 and user_id=$2 for update",
            [input.providerPaymentId, input.userId],
          )
        ).rows[0];
        if (!source || source.merchant_id !== input.merchantId)
          throw new DomainError(
            409,
            "Возврат не соответствует исходному подтверждённому платежу",
          );
        const task = await this.read(tx, source.id);
        const previous = (
          await tx.query<{ task_id: string; amount_kopeks: string }>(
            "select task_id,amount_kopeks::text from npd_refund_observations where provider_refund_id=$1",
            [input.providerRefundId],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.task_id !== task.id ||
            Number(previous.amount_kopeks) !== input.amountKopeks
          )
            throw new DomainError(409, "Возврат уже связан с другой операцией");
          return this.detail(tx, task.id);
        }
        if (
          task.cumulativeRefundedKopeks + input.amountKopeks >
            task.amountKopeks ||
          task.revision === 2_147_483_647
        )
          throw new DomainError(
            409,
            "Возвраты превышают исходную оплату либо требуют проверки ревизии",
          );
        await tx.query(
          "insert into npd_refund_observations(id,provider_refund_id,task_id,amount_kopeks,observed_at,result_revision) values($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            input.providerRefundId,
            task.id,
            input.amountKopeks,
            input.observedAt,
            task.revision + 1,
          ],
        );
        await tx.query(
          "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values(null,'npd-refund-observed','npd-receipt',$1,$2)",
          [
            task.id,
            JSON.stringify({
              providerRefundId: input.providerRefundId,
              amountKopeks: input.amountKopeks,
            }),
          ],
        );
        return this.detail(tx, task.id);
      };
      return await (transaction
        ? work(transaction)
        : this.db.transaction(work));
    } catch (error) {
      return this.conflict(error);
    }
  }
  private conflict(error: unknown): never {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["23505", "23514"].includes(String(error.code))
    )
      throw new DomainError(
        409,
        "Запись реестра конфликтует с уже сохранённым документом или возвратом",
      );
    throw error;
  }
}

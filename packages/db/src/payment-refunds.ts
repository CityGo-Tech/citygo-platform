import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  adminPaymentRefundDetailSchema,
  adminPaymentRefundListSchema,
  adminPaymentRefundSchema,
  adminPaymentSourceListSchema,
  createPaymentRefundSchema,
  creditUserIdSchema,
  ownerPaymentRefundListSchema,
  ownerPaymentRefundSchema,
  ownerPaymentSourceListSchema,
  paymentRefundListQuerySchema,
  paymentRefundReviewReasonSchema,
  type AdminPaymentRefund,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";
import {
  listPaidSourceLots,
  releasePaidRefund,
  reservePaidRefund,
  settlePaidRefund,
} from "./credit-source-lots.js";
import { NpdReceipts } from "./npd-receipts.js";

export type PaymentRefundContext = { userId: string; sessionTokenHash: string };
type PaymentRefundReviewReason = z.infer<
  typeof paymentRefundReviewReasonSchema
>;
const contextSchema = z.strictObject({
  userId: creditUserIdSchema,
  sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const proofSchema = z.strictObject({
  id: z.uuid(),
  refundRequestId: z.uuid(),
  paymentId: z.uuid(),
  orderId: z.uuid(),
  merchantId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  amountKopeks: z.number().int().min(100).max(1_000_000_000),
  currency: z.literal("RUB"),
  test: z.boolean(),
  refundedAmountKopeks: z.number().int().min(0).max(1_000_000_000),
  status: z.enum(["pending", "succeeded", "canceled"]),
  observation: z.enum(["create_response", "server_get"]),
  verifiedAt: z.iso.datetime(),
});
export type PaymentRefundObservation = z.infer<typeof proofSchema>;
export type PaymentRefundDispatchInput = {
  refundRequestId: string;
  paymentId: string;
  orderId: string;
  paymentAmountKopeks: number;
  amountKopeks: number;
  refundedBeforeKopeks: number;
  createdAt: string;
  createPayload?: unknown;
};
const stamp = (column: string) =>
  `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const columns = `id,request_id as "requestId",user_id::text as "userId",
 payment_operation_id as "paymentOperationId",provider_payment_id as "providerPaymentId",
 merchant_id as "merchantId",test,amount_kopeks::integer as "amountKopeks",
 provider_refund_id as "providerRefundId",status,revision,attempt_count as "attemptCount",
 ${stamp("last_attempt_at")} as "lastAttemptAt",review_reason as "reviewReason",
 ${stamp("created_at")} as "createdAt",${stamp("updated_at")} as "updatedAt"`;
const terminal = (row: AdminPaymentRefund) =>
  row.status === "succeeded" || row.status === "canceled";
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(400, "Проверьте параметры возврата");
  return parsed.data;
}
function stored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Stored refund data requires review");
  return parsed.data;
}

// No network. All monetary transitions share the account lock with AI admission.
// Provider evidence can enter only through trusted server methods, never a DTO
// accepted from the buyer or administrator.
export class PaymentRefunds {
  constructor(private db: Database) {}

  private async security(tx: Sql) {
    if (
      !(
        await tx.query(
          "select id from account_security_state where id=1 for update",
        )
      ).rows.length
    )
      throw new DomainError(503, "Денежный журнал не готов");
  }
  private async authorize(
    tx: Sql,
    raw: PaymentRefundContext,
    admin: boolean,
    owner?: string,
  ) {
    const ctx = input(contextSchema, raw);
    const ids = [...new Set([ctx.userId, ...(owner ? [owner] : [])])];
    await tx.query(
      "select id from users where id=any($1::bigint[]) order by id for update",
      [ids],
    );
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
  private async read(tx: Sql, id: string, lock = false) {
    id = input(z.uuid(), id);
    const row = (
      await tx.query<AdminPaymentRefund>(
        `select ${columns} from payment_refunds where id=$1${lock ? " for update" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new DomainError(404, "Возврат не найден");
    return stored(adminPaymentRefundSchema, row);
  }
  private async detail(tx: Sql, id: string) {
    const refund = await this.read(tx, id);
    const events = (
      await tx.query(
        `select sequence::integer,action,actor_user_id::text as "actorUserId",revision,payload,
       ${stamp("created_at")} as "createdAt" from payment_refund_events
       where refund_id=$1 order by sequence desc limit 200`,
        [id],
      )
    ).rows;
    return stored(adminPaymentRefundDetailSchema, { refund, events });
  }
  private async account(tx: Sql, userId: string) {
    if (
      !(
        await tx.query(
          "select user_id from ai_credit_accounts where user_id=$1 for update",
          [userId],
        )
      ).rows.length
    )
      throw new DomainError(409, "Для возврата нужен оплаченный баланс");
  }
  private async event(
    tx: Sql,
    row: AdminPaymentRefund,
    action: string,
    actor: string | null,
    payload: object,
  ) {
    await tx.query(
      "insert into payment_refund_events(refund_id,action,actor_user_id,revision,payload) values($1,$2,$3,$4,$5)",
      [row.id, action, actor, row.revision, JSON.stringify(payload)],
    );
    await tx.query(
      "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values($1,$2,'payment-refund',$3,$4)",
      [
        actor,
        "payment-refund-" + action,
        row.id,
        JSON.stringify({ revision: row.revision }),
      ],
    );
  }
  private async lockTrusted(tx: Sql, id: string) {
    await this.security(tx);
    const peek = await this.read(tx, id);
    await tx.query("select id from users where id=$1 for update", [
      peek.userId,
    ]);
    await this.account(tx, peek.userId);
    return this.read(tx, id, true);
  }
  private async lockActor(tx: Sql, ctx: PaymentRefundContext, id: string) {
    id = input(z.uuid(), id);
    await this.security(tx);
    const owner = (
      await tx.query<{ user_id: string }>(
        "select user_id::text from payment_refunds where id=$1",
        [id],
      )
    ).rows[0];
    // One sorted user lock set, including when the actor ID is above the buyer.
    // Role is checked even when the target ID does not exist.
    await this.authorize(tx, ctx, true, owner?.user_id);
    const peek = await this.read(tx, id);
    await this.account(tx, peek.userId);
    return this.read(tx, id, true);
  }
  private async changed(tx: Sql, id: string) {
    return this.read(tx, id);
  }
  private async review(
    tx: Sql,
    row: AdminPaymentRefund,
    reason: PaymentRefundReviewReason,
    actor: string | null = null,
  ) {
    await tx.query(
      `update payment_refunds set status=$3,review_reason=$2,
      revision=revision+1,dispatch_token=null,dispatch_lease_until=null,updated_at=clock_timestamp() where id=$1`,
      [row.id, reason, terminal(row) ? row.status : "review_required"],
    );
    if (
      [
        "external_refund_drift",
        "payment_mismatch",
        "provider_mismatch",
        "provider_refund_conflict",
      ].includes(reason)
    )
      await tx.query(
        "update ai_credit_accounts set billing_review_required=true where user_id=$1",
        [row.userId],
      );
    const changed = await this.changed(tx, row.id);
    await this.event(tx, changed, "review_required", actor, { reason });
    return changed;
  }

  async create(
    ctx: PaymentRefundContext,
    raw: unknown,
    expected?: { merchantId: string; test: boolean },
  ) {
    const command = input(createPaymentRefundSchema, raw);
    try {
      return await this.db.transaction(async (tx) => {
        await this.security(tx);
        const previous = (
          await tx.query<{
            id: string;
            created_by_user_id: string;
            user_id: string;
          }>(
            "select id,created_by_user_id::text,user_id::text from payment_refunds where request_id=$1",
            [command.requestId],
          )
        ).rows[0];
        const source = (
          await tx.query<{
            user_id: string;
            paid_kopeks: string;
            merchant_id: string;
            test: boolean;
          }>(
            "select user_id::text,paid_kopeks::text,merchant_id,test from ai_credit_topups where operation_id=$1",
            [command.paymentOperationId],
          )
        ).rows[0];
        await this.authorize(
          tx,
          ctx,
          true,
          previous?.user_id ?? source?.user_id,
        );
        if (previous) {
          const row = await this.read(tx, previous.id);
          if (
            row.paymentOperationId !== command.paymentOperationId ||
            row.amountKopeks !== command.amountKopeks ||
            previous.created_by_user_id !== ctx.userId
          )
            throw new DomainError(
              409,
              "ID возврата уже использован с другими параметрами",
            );
          if (
            expected &&
            (row.merchantId !== expected.merchantId ||
              row.test !== expected.test)
          )
            throw new DomainError(409, "Нужен исходный магазин возврата");
          return this.detail(tx, row.id);
        }
        if (!source)
          throw new DomainError(404, "Оплаченное пополнение не найдено");
        if (
          expected &&
          (source.merchant_id !== expected.merchantId ||
            source.test !== expected.test)
        )
          throw new DomainError(
            409,
            "Возврат доступен только для исходного тестового магазина",
          );
        await this.account(tx, source.user_id);
        const id = randomUUID();
        const allocation = await reservePaidRefund(
          tx,
          source.user_id,
          command.paymentOperationId,
          id,
          command.amountKopeks,
        );
        const remaining =
          Number(source.paid_kopeks) -
          allocation.refundedBeforeKopeks -
          command.amountKopeks;
        if (remaining > 0 && remaining < 100)
          throw new DomainError(
            409,
            "Тестовый возврат не должен оставлять остаток менее 1 ₽",
          );
        await tx.query(
          `insert into payment_refunds(id,request_id,created_by_user_id,user_id,payment_operation_id,
          provider_payment_id,merchant_id,test,amount_kopeks,payment_amount_kopeks,refunded_before_kopeks,create_key,create_payload)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1,$12)`,
          [
            id,
            command.requestId,
            ctx.userId,
            source.user_id,
            command.paymentOperationId,
            allocation.providerPaymentId,
            allocation.merchantId,
            allocation.test,
            command.amountKopeks,
            Number(source.paid_kopeks),
            allocation.refundedBeforeKopeks,
            JSON.stringify({
              payment_id: allocation.providerPaymentId,
              amount: {
                value: `${Math.floor(command.amountKopeks / 100)}.${String(command.amountKopeks % 100).padStart(2, "0")}`,
                currency: "RUB",
              },
              description: allocation.test
                ? "Тестовый возврат CityGo"
                : "Возврат средств CityGo",
              metadata: { citygo_refund_id: id },
            }),
          ],
        );
        const row = await this.read(tx, id);
        await this.event(tx, row, "reserved", ctx.userId, {
          amountKopeks: command.amountKopeks,
        });
        return this.detail(tx, id);
      });
    } catch (error) {
      return this.conflict(error);
    }
  }

  async listAdmin(ctx: PaymentRefundContext, raw: unknown = {}) {
    const query = input(paymentRefundListQuerySchema, raw);
    return this.db.transaction(async (tx) => {
      await this.security(tx);
      await this.authorize(tx, ctx, true);
      if (
        query.after &&
        !(
          await tx.query("select id from payment_refunds where id=$1", [
            query.after,
          ])
        ).rows.length
      )
        throw new DomainError(404, "Курсор журнала не найден");
      const rows = (
        await tx.query<AdminPaymentRefund>(
          `select ${columns} from payment_refunds
        where ($1::uuid is null or (created_at,id)<(select created_at,id from payment_refunds where id=$1))
        and ($2::text is null or status=$2) order by created_at desc,id desc limit $3`,
          [query.after ?? null, query.status ?? null, query.limit + 1],
        )
      ).rows;
      return stored(adminPaymentRefundListSchema, {
        refunds: rows.slice(0, query.limit),
        nextAfter: rows.length > query.limit ? rows[query.limit - 1]!.id : null,
      });
    });
  }
  async detailAdmin(ctx: PaymentRefundContext, id: string) {
    return this.db.transaction(async (tx) => {
      await this.security(tx);
      await this.authorize(tx, ctx, true);
      return this.detail(tx, id);
    });
  }
  async listOwner(ctx: PaymentRefundContext) {
    return this.db.transaction(async (tx) => {
      await this.security(tx);
      await this.authorize(tx, ctx, false);
      const rows = (
        await tx.query<AdminPaymentRefund>(
          `select ${columns} from payment_refunds where user_id=$1 order by created_at desc,id desc limit 100`,
          [ctx.userId],
        )
      ).rows;
      return stored(ownerPaymentRefundListSchema, {
        refunds: rows.map((row) =>
          stored(ownerPaymentRefundSchema, {
            id: row.id,
            paymentOperationId: row.paymentOperationId,
            amountKopeks: row.amountKopeks,
            test: row.test,
            status: row.status,
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        ),
      });
    });
  }
  async sources(ctx: PaymentRefundContext, userId?: string) {
    if (userId !== undefined) userId = input(creditUserIdSchema, userId);
    return this.db.transaction(async (tx) => {
      await this.security(tx);
      await this.authorize(tx, ctx, userId !== undefined);
      const owner = userId ?? ctx.userId;
      const rows = await listPaidSourceLots(tx, owner);
      const truncated = rows.length > 100;
      if (userId !== undefined)
        return stored(adminPaymentSourceListSchema, {
          truncated,
          sources: rows.slice(0, 100).map((row) => {
            const projected = { ...row } as Record<string, unknown>;
            delete projected.id;
            return projected;
          }),
        });
      return stored(ownerPaymentSourceListSchema, {
        truncated,
        sources: rows.slice(0, 100).map((row) => {
          const safe = { ...row } as Record<string, unknown>;
          delete safe.id;
          delete safe.providerPaymentId;
          delete safe.merchantId;
          delete safe.userId;
          return safe;
        }),
      });
    });
  }

  private async dispatchInput(
    tx: Sql,
    row: AdminPaymentRefund,
  ): Promise<PaymentRefundDispatchInput> {
    const amounts = (
      await tx.query<{
        payment_amount_kopeks: string;
        refunded_before_kopeks: string;
        create_payload: unknown;
      }>(
        "select payment_amount_kopeks::text,refunded_before_kopeks::text,create_payload from payment_refunds where id=$1",
        [row.id],
      )
    ).rows[0]!;
    return {
      refundRequestId: row.id,
      paymentId: row.providerPaymentId,
      orderId: row.paymentOperationId,
      paymentAmountKopeks: Number(amounts.payment_amount_kopeks),
      amountKopeks: row.amountKopeks,
      refundedBeforeKopeks: Number(amounts.refunded_before_kopeks),
      createdAt: row.createdAt,
      createPayload: amounts.create_payload,
    };
  }
  async prepareDispatch(
    ctx: PaymentRefundContext,
    id: string,
    expected: { merchantId: string; test: boolean },
  ) {
    return this.db.transaction(async (tx) => {
      const row = await this.lockActor(tx, ctx, id);
      if (
        terminal(row) ||
        row.providerRefundId ||
        row.status === "review_required"
      )
        return { detail: await this.detail(tx, id), dispatch: null };
      if (
        row.merchantId !== expected.merchantId ||
        row.test !== expected.test
      ) {
        await this.review(tx, row, "configuration_mismatch", ctx.userId);
        return { detail: await this.detail(tx, id), dispatch: null };
      }
      const timing = (
        await tx.query<{ expired: boolean; leased: boolean }>(
          `select
        created_at<=clock_timestamp()-interval '23 hours' or created_at>clock_timestamp()+interval '1 minute' as expired,
        dispatch_lease_until>clock_timestamp() as leased from payment_refunds where id=$1`,
          [id],
        )
      ).rows[0]!;
      if (timing.expired) {
        await this.review(tx, row, "replay_window_expired", ctx.userId);
        return { detail: await this.detail(tx, id), dispatch: null };
      }
      if (timing.leased)
        throw new DomainError(
          409,
          "Запрос возврата уже выполняется; обновите состояние",
        );
      const token = randomUUID();
      await tx.query(
        `update payment_refunds set status='unknown',review_reason='dispatch_result_unknown',
        revision=revision+1,attempt_count=attempt_count+1,last_attempt_at=clock_timestamp(),
        dispatch_token=$2,dispatch_lease_until=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() where id=$1`,
        [id, token],
      );
      const changed = await this.changed(tx, id);
      await this.event(tx, changed, "dispatch_started", ctx.userId, {});
      return {
        detail: await this.detail(tx, id),
        dispatch: { token, input: await this.dispatchInput(tx, changed) },
      };
    });
  }
  async prepareReconcile(
    ctx: PaymentRefundContext,
    id: string,
    expected: { merchantId: string; test: boolean },
    candidate?: string,
  ) {
    if (candidate !== undefined) candidate = input(z.uuid(), candidate);
    return this.db.transaction(async (tx) => {
      const row = await this.lockActor(tx, ctx, id);
      if (row.merchantId !== expected.merchantId || row.test !== expected.test)
        throw new DomainError(409, "Нужна исходная конфигурация магазина");
      if (
        candidate &&
        row.providerRefundId &&
        row.providerRefundId !== candidate
      )
        throw new DomainError(409, "Возврат уже связан с другим внешним ID");
      const refundId = row.providerRefundId ?? candidate;
      if (!refundId)
        throw new DomainError(
          409,
          "Нужен ID возврата для серверной проверки; это не подтверждение денег",
        );
      return { refundId, input: await this.dispatchInput(tx, row) };
    });
  }

  // A create response can pin an ID, but can NEVER settle/release money.
  // TRUSTED SERVER ONLY. A bound inbox row may request GET reconciliation, not
  // create a refund or invent a provider ID. No session/actor authority is used.
  async prepareServerReconcile(
    id: string,
    expected: { merchantId: string; test: boolean },
  ) {
    input(z.uuid(), id);
    return this.db.transaction(async (tx) => {
      const row = await this.lockTrusted(tx, id);
      if (
        row.merchantId !== expected.merchantId ||
        row.test !== expected.test ||
        !row.providerRefundId
      )
        throw new DomainError(
          409,
          "Нужен сохранённый возврат исходного магазина",
        );
      return {
        refundId: row.providerRefundId,
        input: await this.dispatchInput(tx, row),
      };
    });
  }

  // A create response can pin an ID, but can NEVER settle/release money.
  async recordCreate(id: string, token: string, raw: PaymentRefundObservation) {
    const proof = input(proofSchema, raw);
    if (proof.observation !== "create_response")
      throw new DomainError(400, "Нужен ответ создания");
    return this.db.transaction(async (tx) => {
      const row = await this.lockTrusted(tx, id);
      const saved = (
        await tx.query<{ dispatch_token: string | null }>(
          "select dispatch_token from payment_refunds where id=$1",
          [id],
        )
      ).rows[0]!;
      if (terminal(row)) return this.detail(tx, id);
      if (saved.dispatch_token !== token)
        throw new DomainError(
          409,
          "Попытка уже сменилась; нужна отдельная проверка возврата",
        );
      if (!this.matches(row, proof)) {
        await this.review(tx, row, "provider_mismatch");
        return this.detail(tx, id);
      }
      if (
        (
          await tx.query(
            "select id from payment_refunds where provider_refund_id=$1 and id<>$2",
            [proof.id, id],
          )
        ).rows.length
      ) {
        await this.review(tx, row, "provider_refund_conflict");
        return this.detail(tx, id);
      }
      await tx.query(
        `update payment_refunds set provider_refund_id=$2,status='pending',review_reason=null,
        revision=revision+1,dispatch_token=null,dispatch_lease_until=null,updated_at=clock_timestamp() where id=$1`,
        [id, proof.id],
      );
      await this.event(
        tx,
        await this.changed(tx, id),
        "provider_observed",
        null,
        {
          providerRefundId: proof.id,
          providerStatus: proof.status,
          observation: proof.observation,
        },
      );
      return this.detail(tx, id);
    });
  }
  async recordDispatchFailure(
    id: string,
    token: string,
    reason: PaymentRefundReviewReason,
    review = false,
  ) {
    reason = input(paymentRefundReviewReasonSchema, reason);
    return this.db.transaction(async (tx) => {
      const row = await this.lockTrusted(tx, id);
      const saved = (
        await tx.query<{ dispatch_token: string | null }>(
          "select dispatch_token from payment_refunds where id=$1",
          [id],
        )
      ).rows[0]!;
      if (terminal(row) || saved.dispatch_token !== token)
        return this.detail(tx, id);
      if (review) {
        await this.review(tx, row, reason);
        return this.detail(tx, id);
      }
      await tx.query(
        `update payment_refunds set status='unknown',review_reason=$2,revision=revision+1,
        dispatch_token=null,dispatch_lease_until=null,updated_at=clock_timestamp() where id=$1`,
        [id, reason],
      );
      await this.event(
        tx,
        await this.changed(tx, id),
        "dispatch_failed",
        null,
        { reason },
      );
      return this.detail(tx, id);
    });
  }
  async recordReconcileFailure(
    id: string,
    reason: PaymentRefundReviewReason,
    review = false,
  ) {
    reason = input(paymentRefundReviewReasonSchema, reason);
    return this.db.transaction(async (tx) => {
      const row = await this.lockTrusted(tx, id);
      if (review) {
        await this.review(tx, row, reason);
        return this.detail(tx, id);
      }
      if (terminal(row)) return this.detail(tx, id);
      await tx.query(
        `update payment_refunds set review_reason=$2,revision=revision+1,
        updated_at=clock_timestamp() where id=$1`,
        [id, reason],
      );
      await this.event(
        tx,
        await this.changed(tx, id),
        "dispatch_failed",
        null,
        { reason, observation: "server_get" },
      );
      return this.detail(tx, id);
    });
  }
  private matches(row: AdminPaymentRefund, proof: PaymentRefundObservation) {
    return (
      proof.refundRequestId === row.id &&
      proof.paymentId === row.providerPaymentId &&
      proof.orderId === row.paymentOperationId &&
      proof.merchantId === row.merchantId &&
      proof.test === row.test &&
      proof.amountKopeks === row.amountKopeks &&
      (!row.providerRefundId || row.providerRefundId === proof.id)
    );
  }
  // TRUSTED SERVER ONLY: a separate authenticated GET, never POST's status or
  // the browser's return URL, authorizes the one atomic monetary posting.
  async recordObservation(id: string, raw: PaymentRefundObservation) {
    const proof = input(proofSchema, raw);
    if (proof.observation !== "server_get")
      throw new DomainError(400, "Нужна отдельная серверная проверка");
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.lockTrusted(tx, id);
        if (!this.matches(row, proof)) {
          await this.review(tx, row, "provider_mismatch");
          return this.detail(tx, id);
        }
        if (
          (
            await tx.query(
              "select id from payment_refunds where provider_refund_id=$1 and id<>$2",
              [proof.id, id],
            )
          ).rows.length
        ) {
          await this.review(tx, row, "provider_refund_conflict");
          return this.detail(tx, id);
        }
        const dispatch = await this.dispatchInput(tx, row);
        const currentSource = (
          await tx.query<{ refunded: string }>(
            "select (refunded_micros/10000)::text as refunded from credit_source_lots where paid_operation_id=$1 and user_id=$2",
            [row.paymentOperationId, row.userId],
          )
        ).rows[0];
        if (!currentSource)
          throw new DomainError(409, "Оплаченный источник требует сверки");
        const historicalTotal =
          dispatch.refundedBeforeKopeks +
          (row.status === "succeeded" ? row.amountKopeks : 0);
        if (terminal(row)) {
          // A GET begun earlier may arrive after another GET settled this or a
          // later refund. Pending can never regress a known terminal posting.
          const minimum =
            proof.status === "pending"
              ? dispatch.refundedBeforeKopeks
              : historicalTotal;
          if (
            proof.refundedAmountKopeks < minimum ||
            proof.refundedAmountKopeks > Number(currentSource.refunded)
          )
            await this.review(tx, row, "external_refund_drift");
          else if (proof.status !== "pending" && row.status !== proof.status)
            await this.review(tx, row, "provider_mismatch");
          return this.detail(tx, id);
        }
        const expectedTotal =
          dispatch.refundedBeforeKopeks +
          (proof.status === "succeeded" ? row.amountKopeks : 0);
        // We support serialized in-app refunds, not silent out-of-band refunds.
        if (
          proof.refundedAmountKopeks !== expectedTotal &&
          !(
            proof.status === "pending" &&
            proof.refundedAmountKopeks ===
              dispatch.refundedBeforeKopeks + row.amountKopeks
          )
        ) {
          await this.review(tx, row, "external_refund_drift");
          return this.detail(tx, id);
        }
        if (proof.status === "succeeded") {
          await settlePaidRefund(tx, row.userId, id);
          if (!row.test)
            await new NpdReceipts(this.db).observeConfirmedRefund(
              {
                userId: row.userId,
                providerPaymentId: row.providerPaymentId,
                providerRefundId: proof.id,
                merchantId: row.merchantId,
                amountKopeks: row.amountKopeks,
                currency: "RUB",
                test: false,
                status: "succeeded",
                verification: "server_get_succeeded",
                observedAt: proof.verifiedAt,
              },
              tx,
            );
        } else if (proof.status === "canceled")
          await releasePaidRefund(tx, row.userId, id);
        await tx.query(
          `update payment_refunds set provider_refund_id=$2,status=$3,review_reason=null,
          revision=revision+1,dispatch_token=null,dispatch_lease_until=null,updated_at=clock_timestamp() where id=$1`,
          [id, proof.id, proof.status],
        );
        await this.event(
          tx,
          await this.changed(tx, id),
          "provider_observed",
          null,
          {
            providerRefundId: proof.id,
            providerStatus: proof.status,
            observation: proof.observation,
          },
        );
        return this.detail(tx, id);
      });
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
        "Денежная операция конфликтует с сохранённым источником или возвратом",
      );
    throw error;
  }
}

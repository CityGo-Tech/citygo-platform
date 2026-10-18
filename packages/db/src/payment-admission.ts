import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  creditUserIdSchema,
  paymentAdmissionCommandSchema,
  type PaymentAdmissionState,
  type PaymentAdmissionStatus,
  type PaymentAdmissionUserStatus,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const bindingSchema = z.strictObject({
  merchantId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  runtimePolicyId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PaymentAdmissionBinding = z.infer<typeof bindingSchema>;
const contextSchema = z.strictObject({
  userId: creditUserIdSchema,
  sessionTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PaymentAdmissionContext = z.infer<typeof contextSchema>;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new DomainError(400, "Некорректная команда допуска оплаты");
  return result.data;
}
const stamp = (field: string) =>
  `to_char(${field} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
async function securityLock(tx: Sql) {
  if (
    !(
      await tx.query(
        "select id from account_security_state where id=1 for update",
      )
    ).rows.length
  )
    throw new DomainError(503, "Состояние допуска оплаты не готово");
}
async function lockAdmission(tx: Sql) {
  if (
    !(await tx.query("select id from payment_admission where id=1 for update"))
      .rows.length
  )
    throw new DomainError(503, "Состояние допуска оплаты не готово");
}
async function readStatus(
  tx: Sql,
  binding: PaymentAdmissionBinding,
): Promise<PaymentAdmissionState> {
  const row = (
    await tx.query<Omit<PaymentAdmissionState, "available">>(
      `
    select p.revision,p.accepting_new_checkouts as "acceptingNewCheckouts",
      p.reconciliation_enabled as "reconciliationEnabled",p.mode,p.owner_user_id::text as "ownerUserId",
      ${stamp("p.lease_until")} as "leaseUntil",
      p.manual_npd_responsibility_accepted as "manualNpdResponsibilityAccepted",
      ${stamp("p.reconciliation_checked_at")} as "reconciliationCheckedAt",p.reconciliation_ok as "reconciliationOk",
      coalesce(p.merchant_id=$1 and p.runtime_policy_id=$2,false) as "runtimeBindingMatches",
      case when not p.accepting_new_checkouts then 'closed'
        when p.merchant_id is distinct from $1 or p.runtime_policy_id is distinct from $2 then 'binding_mismatch'
        when not exists(select 1 from users u where u.id=p.owner_user_id and u.status='active'
          and u.role='super_admin' and not u.must_change_password) then 'operator_inactive'
        when p.mode='lease' and (p.lease_until<=clock_timestamp() or not exists(select 1 from sessions s
          where s.token_hash=p.lease_session_token_hash and s.user_id=p.owner_user_id and s.expires_at>clock_timestamp())) then 'lease_expired'
        when not p.reconciliation_enabled then 'reconciliation_disabled'
        when not p.reconciliation_ok then 'reconciliation_unhealthy'
        when p.reconciliation_checked_at is null or p.reconciliation_checked_at>clock_timestamp()
          or p.reconciliation_checked_at<clock_timestamp()-interval '120 seconds' then 'reconciliation_stale'
        else null end as reason
      from payment_admission p where p.id=1`,
      [binding.merchantId, binding.runtimePolicyId],
    )
  ).rows[0];
  if (!row) throw new DomainError(503, "Состояние допуска оплаты не готово");
  return { ...row, available: row.reason === null };
}
async function readAdminStatus(
  tx: Sql,
  binding: PaymentAdmissionBinding,
): Promise<PaymentAdmissionStatus> {
  const status = await readStatus(tx, binding);
  const npdBacklog = (
    await tx.query<PaymentAdmissionStatus["npdBacklog"]>(
      `
    select count(*) filter(where registration_status='pending')::integer as "pendingRegistration",
      count(*) filter(where delivery_status='pending')::integer as "pendingDelivery",
      count(*) filter(where correction_status='required')::integer as "requiredCorrection",
      count(*) filter(where review_reason is not null)::integer as review,
      count(*)::integer as total,${stamp("min(observed_at)")} as "oldestObservedAt"
    from npd_receipt_tasks where merchant_id=$1 and
      (registration_status='pending' or delivery_status='pending' or correction_status='required' or review_reason is not null)`,
      [binding.merchantId],
    )
  ).rows[0]!;
  return { ...status, npdBacklog };
}

// Call BEFORE payer/order locks in the same short transaction. No provider I/O.
// A close serializes with order creation; closing never blocks old settlement.
export async function assertLiveCheckoutAdmission(
  tx: Sql,
  raw: PaymentAdmissionBinding,
): Promise<void> {
  const binding = parse(bindingSchema, raw);
  await securityLock(tx);
  await lockAdmission(tx);
  const state = await readStatus(tx, binding);
  if (!state.available)
    throw new DomainError(503, "Новые пополнения временно недоступны");
  if (state.mode === "lease") {
    // Logout cannot remove the lease session until this order transaction ends.
    await tx.query(`select s.token_hash from sessions s join payment_admission p
      on s.token_hash=p.lease_session_token_hash and s.user_id=p.owner_user_id
      where p.id=1 and s.expires_at>clock_timestamp() for update of s`);
    if (!(await readStatus(tx, binding)).available)
      throw new DomainError(503, "Новые пополнения временно недоступны");
  }
}

// No transport or fiscal actions. Both binding values are trusted server config,
// not fields an admin/browser may submit. Reconciliation runs outside DB locks.
export class PaymentAdmission {
  private binding: PaymentAdmissionBinding;
  constructor(
    private db: Database,
    raw: PaymentAdmissionBinding,
  ) {
    this.binding = parse(bindingSchema, raw);
  }
  private async authorize(tx: Sql, raw: PaymentAdmissionContext) {
    const ctx = parse(contextSchema, raw);
    await securityLock(tx);
    await tx.query("select id from users where id=$1 for update", [ctx.userId]);
    const row = (
      await tx.query<{ role: string; must_change_password: boolean }>(
        `
      select u.role,u.must_change_password from sessions s join users u on u.id=s.user_id
      where s.token_hash=$1 and s.user_id=$2 and s.expires_at>clock_timestamp()
        and u.status='active' for update of s`,
        [ctx.sessionTokenHash, ctx.userId],
      )
    ).rows[0];
    if (!row) throw new DomainError(401, "Войдите в аккаунт");
    if (row.role !== "super_admin" || row.must_change_password)
      throw new DomainError(
        403,
        "Нужны актуальные права super admin и смена временного пароля",
      );
    return ctx;
  }
  statusAdmin(ctx: PaymentAdmissionContext) {
    return this.db.transaction(async (tx) => {
      await this.authorize(tx, ctx);
      return readAdminStatus(tx, this.binding);
    });
  }
  async statusUser(): Promise<PaymentAdmissionUserStatus> {
    const status = await readStatus(this.db, this.binding);
    return { available: status.available };
  }
  async command(
    ctx: PaymentAdmissionContext,
    raw: unknown,
  ): Promise<PaymentAdmissionStatus> {
    const command = parse(paymentAdmissionCommandSchema, raw);
    return this.db.transaction(async (tx) => {
      const actor = await this.authorize(tx, ctx);
      await lockAdmission(tx);
      const previous = (
        await tx.query<{
          actor_user_id: string;
          merchant_id: string;
          runtime_policy_id: string;
          payload: unknown;
        }>(
          `select actor_user_id::text,merchant_id,runtime_policy_id,payload from payment_admission_commands where request_id=$1`,
          [command.requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.actor_user_id !== actor.userId ||
          previous.merchant_id !== this.binding.merchantId ||
          previous.runtime_policy_id !== this.binding.runtimePolicyId ||
          !isDeepStrictEqual(previous.payload, command)
        )
          throw new DomainError(
            409,
            "ID команды уже использован с другими параметрами",
          );
        return readAdminStatus(tx, this.binding);
      }
      const state = await readStatus(tx, this.binding);
      if (
        state.revision !== command.expectedRevision ||
        state.revision === 2_147_483_647 ||
        (state.revision === 2_147_483_646 && command.action !== "close")
      )
        throw new DomainError(
          409,
          "Допуск оплаты изменился. Обновите состояние",
        );
      // Any config rebinding invalidates old health/lease, never carries an old
      // enabled flag into another merchant or runtime policy.
      if (!state.runtimeBindingMatches)
        await tx.query(
          `update payment_admission set
        merchant_id=$1,runtime_policy_id=$2,accepting_new_checkouts=false,mode='closed',
        owner_user_id=null,lease_session_token_hash=null,lease_until=null,
        manual_npd_responsibility_accepted=false,reconciliation_enabled=false,
        reconciliation_ok=false,reconciliation_checked_at=null where id=1`,
          [this.binding.merchantId, this.binding.runtimePolicyId],
        );
      if (command.action === "open") {
        await tx.query(
          `update payment_admission set accepting_new_checkouts=true,mode=$1,
          owner_user_id=$2,lease_session_token_hash=$3,lease_until=case when $4::integer is null then null
            else clock_timestamp()+$4::integer*interval '1 second' end,
          manual_npd_responsibility_accepted=$5 where id=1`,
          [
            command.mode,
            actor.userId,
            command.mode === "lease" ? actor.sessionTokenHash : null,
            command.mode === "lease" ? command.leaseSeconds : null,
            command.manualNpdResponsibilityAccepted,
          ],
        );
      } else if (command.action === "close") {
        await tx.query(`update payment_admission set accepting_new_checkouts=false,mode='closed',
          lease_session_token_hash=null,lease_until=null where id=1`);
      } else {
        await tx.query(
          `update payment_admission set reconciliation_enabled=$1,
          reconciliation_ok=false,reconciliation_checked_at=null where id=1`,
          [command.enabled],
        );
      }
      await tx.query(`update payment_admission set revision=revision+1,updated_at=clock_timestamp(),
        reconciliation_run_id=null,reconciliation_run_revision=null,reconciliation_run_until=null where id=1`);
      const result = await readAdminStatus(tx, this.binding);
      await tx.query(
        `insert into payment_admission_commands(request_id,actor_user_id,merchant_id,runtime_policy_id,payload,result_revision,result)
        values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
        [
          command.requestId,
          actor.userId,
          this.binding.merchantId,
          this.binding.runtimePolicyId,
          JSON.stringify(command),
          result.revision,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }
  async beginReconciliation(): Promise<{
    runId: string;
    revision: number;
  } | null> {
    return this.db.transaction(async (tx) => {
      await securityLock(tx);
      await lockAdmission(tx);
      const runId = randomUUID();
      const row = (
        await tx.query<{ revision: number }>(
          `update payment_admission set
        reconciliation_run_id=$1,reconciliation_run_revision=revision,
        reconciliation_run_until=clock_timestamp()+interval '120 seconds'
        where id=1 and reconciliation_enabled and merchant_id=$2 and runtime_policy_id=$3
          and (reconciliation_run_id is null or reconciliation_run_until<=clock_timestamp()) returning revision`,
          [runId, this.binding.merchantId, this.binding.runtimePolicyId],
        )
      ).rows[0];
      return row ? { runId, revision: row.revision } : null;
    });
  }
  async completeReconciliation(raw: {
    runId: string;
    revision: number;
    success: boolean;
  }): Promise<boolean> {
    const result = parse(
      z.strictObject({
        runId: z.uuid(),
        revision: z.number().int().positive(),
        success: z.boolean(),
      }),
      raw,
    );
    return this.db.transaction(async (tx) => {
      await securityLock(tx);
      await lockAdmission(tx);
      const changed =
        (
          await tx.query(
            `update payment_admission set reconciliation_ok=$1,
        reconciliation_checked_at=clock_timestamp(),reconciliation_run_id=null,
        reconciliation_run_revision=null,reconciliation_run_until=null
        where id=1 and merchant_id=$2 and runtime_policy_id=$3 and reconciliation_enabled
          and revision=$4 and reconciliation_run_revision=$4 and reconciliation_run_id=$5
          and reconciliation_run_until>clock_timestamp() returning id`,
            [
              result.success,
              this.binding.merchantId,
              this.binding.runtimePolicyId,
              result.revision,
              result.runId,
            ],
          )
        ).rows.length > 0;
      if (changed)
        await tx.query(
          `insert into payment_admission_reconciliation_events
        (run_id,admission_revision,merchant_id,runtime_policy_id,success) values($1,$2,$3,$4,$5)`,
          [
            result.runId,
            result.revision,
            this.binding.merchantId,
            this.binding.runtimePolicyId,
            result.success,
          ],
        );
      return changed;
    });
  }
}

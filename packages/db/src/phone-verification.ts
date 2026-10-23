import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AI_WELCOME_CREDIT_MICROS,
  CITYGO_MAX_AMOUNT_MICROS,
  creditUserIdSchema,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(1_000_000);
const policySchema = z.strictObject({
  identityKeyFingerprint: digest,
  normalizationVersion: z.literal("e164-v1"),
  limits: z.strictObject({
    userHourly: count,
    phoneHourly: count,
    ipHourly: count,
    cooldownSeconds: z.number().int().min(0).max(86400),
    globalDaily: count,
    globalTotal: count,
  }),
});
const contextSchema = z.strictObject({
  userId: creditUserIdSchema,
  sessionTokenHash: digest,
});
const beginSchema = z.strictObject({
  id: z.uuid(),
  phoneKey: digest,
  proofHash: digest,
  codeHash: digest,
  ipKey: digest,
});
const confirmSchema = beginSchema.omit({ ipKey: true });
export type PhoneVerificationPolicy = z.infer<typeof policySchema>;
export type PhoneVerificationContext = z.infer<typeof contextSchema>;
export type PhoneVerificationBegin = z.infer<typeof beginSchema>;
export type PhoneVerificationConfirm = z.infer<typeof confirmSchema>;
export type PhoneVerificationReceipt = {
  operationId: string;
  grantedMicros: number;
  alreadyGranted: boolean;
};
type Challenge = {
  id: string;
  user_id: string;
  phone_key: string;
  proof_hash: string;
  code_hash: string;
  policy_fingerprint: string;
  delivery: "pending" | "accepted" | "failed";
  attempts: number;
  expired: boolean;
  superseded: boolean;
  consumed_operation_id: string | null;
};
function invalid() {
  return new DomainError(400, "Код подтверждения недействителен или истёк");
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw invalid();
  return result.data;
}
function equal(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function policyValue(raw: PhoneVerificationPolicy) {
  const policy = parse(policySchema, raw);
  // Explicit property ordering makes the binding independent of caller key order.
  const canonical = JSON.stringify({
    identityKeyFingerprint: policy.identityKeyFingerprint,
    normalizationVersion: policy.normalizationVersion,
    limits: {
      userHourly: policy.limits.userHourly,
      phoneHourly: policy.limits.phoneHourly,
      ipHourly: policy.limits.ipHourly,
      cooldownSeconds: policy.limits.cooldownSeconds,
      globalDaily: policy.limits.globalDaily,
      globalTotal: policy.limits.globalTotal,
    },
  });
  return {
    policy,
    canonical,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}
async function security(tx: Sql) {
  if (
    (
      await tx.query(
        "select id from account_security_state where id=1 for update",
      )
    ).rows.length !== 1
  )
    throw new DomainError(503, "Хранилище подтверждения телефона не готово");
}

// Operator DB connection only. No HTTP route, automatic startup call, overwrite,
// API UPDATE grant, external I/O or real provider activation belongs here.
export async function configurePhoneVerification(
  db: Database,
  raw: PhoneVerificationPolicy,
) {
  const value = policyValue(raw);
  await db.transaction(async (tx) => {
    await security(tx);
    const current = (
      await tx.query<{ policy_fingerprint: string | null }>(
        "select policy_fingerprint from phone_verification_control where id=1 for update",
      )
    ).rows[0];
    if (!current)
      throw new DomainError(503, "Политика подтверждения телефона не готова");
    if (current.policy_fingerprint === value.fingerprint) return;
    if (current.policy_fingerprint !== null)
      throw new DomainError(
        409,
        "Политика телефона уже закреплена; изменение требует отдельной миграции",
      );
    await tx.query(
      `update phone_verification_control set identity_key_fingerprint=$1,
      policy_fingerprint=$2,policy=$3::jsonb,bound_at=clock_timestamp() where id=1`,
      [value.policy.identityKeyFingerprint, value.fingerprint, value.canonical],
    );
  });
}

// Staged server primitive only: HMACs/normalization and provider network delivery
// are outside SQL. No adapter, runtime enablement or user-supplied "verified" flag.
export class PhoneVerification {
  private value: ReturnType<typeof policyValue>;
  constructor(
    private db: Database,
    policy: PhoneVerificationPolicy,
  ) {
    this.value = policyValue(policy);
  }
  async readiness(): Promise<boolean> {
    const current = (
      await this.db.query<{
        policy_fingerprint: string | null;
        identity_key_fingerprint: string | null;
      }>(
        "select policy_fingerprint,identity_key_fingerprint from phone_verification_control where id=1",
      )
    ).rows[0];
    return Boolean(
      current &&
      current.policy_fingerprint === this.value.fingerprint &&
      current.identity_key_fingerprint ===
        this.value.policy.identityKeyFingerprint,
    );
  }
  async status(rawContext: PhoneVerificationContext) {
    return this.db.transaction(async (tx) => {
      const ctx = await this.authorize(tx, rawContext);
      const granted = await tx.query(
        "select 1 from ai_credit_entries where user_id=$1 and kind='bonus'",
        [ctx.userId],
      );
      return { alreadyGranted: granted.rows.length > 0 };
    });
  }
  private async bound(tx: Sql) {
    const current = (
      await tx.query<{
        policy_fingerprint: string | null;
        identity_key_fingerprint: string | null;
      }>(
        "select policy_fingerprint,identity_key_fingerprint from phone_verification_control where id=1",
      )
    ).rows[0];
    if (
      !current ||
      current.policy_fingerprint !== this.value.fingerprint ||
      current.identity_key_fingerprint !==
        this.value.policy.identityKeyFingerprint
    )
      throw new DomainError(
        503,
        "Политика или ключ телефона требуют отдельной настройки оператором",
      );
  }
  private async authorize(tx: Sql, raw: PhoneVerificationContext) {
    const ctx = parse(contextSchema, raw);
    await security(tx);
    await this.bound(tx);
    await tx.query("select id from users where id=$1 for update", [ctx.userId]);
    const current = (
      await tx.query<{
        must_change_password: boolean;
        email_verified: boolean;
      }>(
        `select u.must_change_password,exists(select 1 from account_email_verifications e
          join user_credentials c on c.user_id=e.user_id and c.email=e.email
          where e.user_id=u.id) as email_verified from sessions s join users u on u.id=s.user_id
       where s.token_hash=$1 and s.user_id=$2 and s.expires_at>clock_timestamp()
       and u.status='active' for update of s`,
        [ctx.sessionTokenHash, ctx.userId],
      )
    ).rows[0];
    if (!current) throw new DomainError(401, "Войдите в аккаунт");
    if (current.must_change_password)
      throw new DomainError(403, "Сначала смените временный пароль");
    if (!current.email_verified)
      throw new DomainError(403, "Сначала подтвердите электронную почту");
    return ctx;
  }
  private async eligible(tx: Sql, userId: string, phoneKey: string) {
    if (
      (
        await tx.query(
          `select 1 from ai_credit_entries where user_id=$1 and kind='bonus'
      union all select 1 from phone_welcome_claims where user_id=$1 or phone_key=$2`,
          [userId, phoneKey],
        )
      ).rows.length
    )
      throw new DomainError(409, "Разовый подарок уже использован");
  }
  private async quota(
    tx: Sql,
    userId: string,
    phoneKey: string,
    ipKey: string,
  ) {
    const limits = this.value.policy.limits;
    const row = (
      await tx.query<{
        user_count: number;
        phone_count: number;
        ip_count: number;
        daily_count: number;
        total_count: number;
        cooldown: boolean;
      }>(
        `select count(*) filter(where user_id=$1 and created_at>clock_timestamp()-interval '1 hour')::int as user_count,
       count(*) filter(where phone_key=$2 and created_at>clock_timestamp()-interval '1 hour')::int as phone_count,
       count(*) filter(where ip_key=$3 and created_at>clock_timestamp()-interval '1 hour')::int as ip_count,
       count(*) filter(where created_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')::int as daily_count,
       count(*)::int as total_count,
       coalesce(bool_or((user_id=$1 or phone_key=$2) and created_at>clock_timestamp()-($4::integer*interval '1 second')),false) as cooldown
       from phone_verification_sends`,
        [userId, phoneKey, ipKey, limits.cooldownSeconds],
      )
    ).rows[0]!;
    if (
      row.user_count >= limits.userHourly ||
      row.phone_count >= limits.phoneHourly ||
      row.ip_count >= limits.ipHourly ||
      row.daily_count >= limits.globalDaily ||
      row.total_count >= limits.globalTotal ||
      row.cooldown
    )
      throw new DomainError(429, "Слишком много отправок. Попробуйте позже");
  }
  private async sendAdmission(
    tx: Sql,
    id: string,
    userId: string,
    phoneKey: string,
    ipKey: string,
  ) {
    await tx.query(
      `insert into phone_verification_sends(id,challenge_id,user_id,phone_key,ip_key,policy_fingerprint)
      values($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), id, userId, phoneKey, ipKey, this.value.fingerprint],
    );
  }
  private async challenge(tx: Sql, id: string): Promise<Challenge | undefined> {
    return (
      await tx.query<Challenge>(
        `select id::text,user_id::text,phone_key,proof_hash,code_hash,policy_fingerprint,
      delivery,attempts,expires_at<=clock_timestamp() as expired,superseded_at is not null as superseded,
      consumed_operation_id::text from phone_verification_challenges where id=$1 for update`,
        [id],
      )
    ).rows[0];
  }
  private matches(
    current: Challenge | undefined,
    ctx: PhoneVerificationContext,
    input: PhoneVerificationConfirm,
  ) {
    return (
      current &&
      current.user_id === ctx.userId &&
      current.phone_key === input.phoneKey &&
      current.policy_fingerprint === this.value.fingerprint &&
      equal(current.proof_hash, input.proofHash)
    );
  }
  async begin(
    rawContext: PhoneVerificationContext,
    raw: PhoneVerificationBegin,
  ) {
    const input = parse(beginSchema, raw);
    return this.db.transaction(async (tx) => {
      const ctx = await this.authorize(tx, rawContext);
      await this.eligible(tx, ctx.userId, input.phoneKey);
      if (
        (
          await tx.query(
            "select id from phone_verification_challenges where id=$1",
            [input.id],
          )
        ).rows.length
      )
        throw new DomainError(409, "Попытка подтверждения уже существует");
      await this.quota(tx, ctx.userId, input.phoneKey, input.ipKey);
      await tx.query(
        `update phone_verification_challenges set superseded_at=clock_timestamp()
        where user_id=$1 and consumed_at is null and superseded_at is null`,
        [ctx.userId],
      );
      const result = (
        await tx.query<{ id: string; expiresAt: string }>(
          `insert into phone_verification_challenges(id,user_id,phone_key,proof_hash,code_hash,policy_fingerprint,expires_at)
         values($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')
         returning id::text,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
          [
            input.id,
            ctx.userId,
            input.phoneKey,
            input.proofHash,
            input.codeHash,
            this.value.fingerprint,
          ],
        )
      ).rows[0]!;
      await this.sendAdmission(
        tx,
        input.id,
        ctx.userId,
        input.phoneKey,
        input.ipKey,
      );
      return result;
    });
  }
  async resend(
    rawContext: PhoneVerificationContext,
    raw: PhoneVerificationBegin,
  ) {
    const input = parse(beginSchema, raw);
    return this.db.transaction(async (tx) => {
      const ctx = await this.authorize(tx, rawContext),
        current = await this.challenge(tx, input.id);
      if (
        !this.matches(current, ctx, input) ||
        current!.consumed_operation_id ||
        current!.superseded ||
        equal(current!.code_hash, input.codeHash)
      )
        throw invalid();
      await this.eligible(tx, ctx.userId, input.phoneKey);
      await this.quota(tx, ctx.userId, input.phoneKey, input.ipKey);
      const result = (
        await tx.query<{ id: string; expiresAt: string }>(
          `update phone_verification_challenges set code_hash=$2,delivery='pending',attempts=0,
         expires_at=clock_timestamp()+interval '10 minutes' where id=$1
         returning id::text,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
          [input.id, input.codeHash],
        )
      ).rows[0]!;
      await this.sendAdmission(
        tx,
        input.id,
        ctx.userId,
        input.phoneKey,
        input.ipKey,
      );
      return result;
    });
  }
  async markAccepted(id: string, codeHash: string) {
    await this.delivery(id, codeHash, "accepted");
  }
  async cancelDelivery(id: string, codeHash: string) {
    await this.delivery(id, codeHash, "failed");
  }
  private async delivery(
    id: string,
    codeHash: string,
    state: "accepted" | "failed",
  ) {
    parse(z.uuid(), id);
    parse(digest, codeHash);
    const changed = await this.db.query(
      `update phone_verification_challenges set delivery=$3
      where id=$1 and code_hash=$2 and delivery='pending' and consumed_at is null
      and superseded_at is null and expires_at>clock_timestamp() returning id`,
      [id, codeHash, state],
    );
    if (changed.rows.length !== 1) throw invalid();
  }
  async confirm(
    rawContext: PhoneVerificationContext,
    raw: PhoneVerificationConfirm,
  ): Promise<PhoneVerificationReceipt> {
    const input = parse(confirmSchema, raw);
    const result = await this.db.transaction(async (tx) => {
      const ctx = await this.authorize(tx, rawContext);
      // Match the financial order: security -> user/session -> credit -> challenge.
      await tx.query(
        "select user_id from ai_credit_accounts where user_id=$1 for update",
        [ctx.userId],
      );
      const current = await this.challenge(tx, input.id);
      if (!this.matches(current, ctx, input)) return { error: invalid() };
      if (current!.consumed_operation_id) {
        if (!equal(current!.code_hash, input.codeHash))
          return { error: invalid() };
        const claim = (
          await tx.query<{ operation_id: string }>(
            `select operation_id::text from phone_welcome_claims
          where user_id=$1 and phone_key=$2 and challenge_id=$3 and operation_id=$4`,
            [
              ctx.userId,
              input.phoneKey,
              input.id,
              current!.consumed_operation_id,
            ],
          )
        ).rows[0];
        if (!claim)
          throw new DomainError(503, "Подтверждение подарка требует сверки");
        return {
          receipt: {
            operationId: claim.operation_id,
            grantedMicros: AI_WELCOME_CREDIT_MICROS,
            alreadyGranted: true,
          },
        };
      }
      if (
        current!.expired ||
        current!.superseded ||
        current!.delivery !== "accepted" ||
        current!.attempts >= 5
      )
        return { error: invalid() };
      if (!equal(current!.code_hash, input.codeHash)) {
        // Returning the error lets the failed attempt COMMIT before throwing.
        await tx.query(
          "update phone_verification_challenges set attempts=attempts+1 where id=$1",
          [input.id],
        );
        return { error: invalid() };
      }
      await this.eligible(tx, ctx.userId, input.phoneKey);
      await tx.query(
        "insert into ai_credit_accounts(user_id) values($1) on conflict do nothing",
        [ctx.userId],
      );
      await tx.query(
        "select user_id from ai_credit_accounts where user_id=$1 for update",
        [ctx.userId],
      );
      const operationId = randomUUID();
      // Existing invoker triggers create exactly one gift source and repay any
      // existing fixed5 debt. No nested grantWelcome transaction or second lot.
      await tx.query(
        `insert into ai_credit_entries(user_id,operation_id,kind,amount_micros,actor_user_id)
        values($1,$2,'bonus',$3,$1)`,
        [ctx.userId, operationId, AI_WELCOME_CREDIT_MICROS],
      );
      const credited = await tx.query(
        `update ai_credit_accounts set granted_micros=granted_micros+$2::bigint
        where user_id=$1 and granted_micros<=$3::bigint-$2::bigint returning user_id`,
        [ctx.userId, AI_WELCOME_CREDIT_MICROS, CITYGO_MAX_AMOUNT_MICROS],
      );
      if (credited.rows.length !== 1)
        throw new DomainError(409, "Превышен технический предел баланса");
      await tx.query(
        `update phone_verification_challenges set consumed_at=clock_timestamp(),consumed_operation_id=$2 where id=$1`,
        [input.id, operationId],
      );
      await tx.query(
        `insert into phone_welcome_claims(user_id,phone_key,challenge_id,operation_id,granted_micros)
        values($1,$2,$3,$4,$5)`,
        [
          ctx.userId,
          input.phoneKey,
          input.id,
          operationId,
          AI_WELCOME_CREDIT_MICROS,
        ],
      );
      await tx.query(
        `insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)
        values($1,'ai-credit-phone-welcome-granted','ai-credit',$2,$3::jsonb)`,
        [
          ctx.userId,
          ctx.userId,
          JSON.stringify({
            method: "phone-code",
            amountMicros: AI_WELCOME_CREDIT_MICROS,
            operationId,
          }),
        ],
      );
      return {
        receipt: {
          operationId,
          grantedMicros: AI_WELCOME_CREDIT_MICROS,
          alreadyGranted: false,
        },
      };
    });
    if (result.error) throw result.error;
    return result.receipt!;
  }
}

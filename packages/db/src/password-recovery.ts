import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "./index.js";
import type { EmailSendLimits } from "./email-registration.js";
import { DomainError } from "./errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.uuid();
const beginSchema = z.strictObject({
  id: idSchema,
  email: z.email().max(254),
  proofHash: digest,
  codeHash: digest,
  recipientKey: digest,
  ipKey: digest,
});
const resendSchema = z.strictObject({
  id: idSchema,
  proofHash: digest,
  codeHash: digest,
  ipKey: digest,
});
const confirmSchema = z.strictObject({
  id: idSchema,
  proofHash: digest,
  codeHash: digest,
  newPasswordHash: z.string().min(1).max(2048),
});
export type PasswordRecoveryBegin = z.infer<typeof beginSchema>;
export type PasswordRecoveryResend = z.infer<typeof resendSchema>;
export type PasswordRecoveryConfirm = z.infer<typeof confirmSchema>;
// email is an INTERNAL delivery instruction. Never include it in an HTTP reply.
export type PasswordRecoveryChallenge = {
  id: string;
  expiresAt: string;
  email?: string;
};
type Challenge = {
  id: string;
  target_user_id: string | null;
  credential_digest: string | null;
  proof_hash: string;
  code_hash: string;
  recipient_key: string;
  delivery: "pending" | "sent" | "failed";
  attempts: number;
  expiresAt: string;
  expired: boolean;
  consumed_at: string | null;
  invalidated_at: string | null;
};
type Eligible = { id: string; email: string; password_hash: string };
const credentialDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function invalid() {
  return new DomainError(400, "Код восстановления недействителен или истёк");
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
function equal(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
async function lockSecurity(tx: Sql) {
  const state = await tx.query(
    "select id from account_security_state where id=1 for update",
  );
  if (state.rows.length !== 1)
    throw new DomainError(503, "Хранилище аккаунтов не готово");
}
async function eligible(tx: Sql, userId: string) {
  return (
    await tx.query<Eligible>(
      `select u.id::text,c.email,c.password_hash from users u
       join user_credentials c on c.user_id=u.id
       join account_email_verifications e on e.user_id=u.id and e.email=c.email
       where u.id=$1 and u.status='active' and c.email not like '%.invalid'`,
      [userId],
    )
  ).rows[0];
}
// Follow AccountAccess's singleton -> user -> challenge order. The initial
// nonlocking lookup is safe under the singleton shared by all security writers.
async function pending(tx: Sql, id: string) {
  const owner = (
    await tx.query<{ target_user_id: string | null }>(
      "select target_user_id::text from password_recovery_challenges where id=$1",
      [id],
    )
  ).rows[0];
  if (owner?.target_user_id)
    await tx.query("select id from users where id=$1 for update", [
      owner.target_user_id,
    ]);
  return (
    await tx.query<Challenge>(
      `select id::text,target_user_id::text,credential_digest,proof_hash,code_hash,recipient_key,delivery,attempts,
       to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
       expires_at<=clock_timestamp() as expired,consumed_at,invalidated_at
       from password_recovery_challenges where id=$1 for update`,
      [id],
    )
  ).rows[0];
}
async function deliveryEmail(tx: Sql, current: Challenge) {
  if (!current.target_user_id || !current.credential_digest) return undefined;
  const user = await eligible(tx, current.target_user_id);
  return user &&
    equal(current.credential_digest, credentialDigest(user.password_hash))
    ? user.email
    : undefined;
}

// Deliberately shares registration's durable journal and singleton lock. Every
// admitted decoy and failed delivery consumes the same recipient/IP/global caps.
async function quota(
  tx: Sql,
  recipientKey: string,
  ipKey: string,
  global?: EmailSendLimits,
) {
  if (global && (global.daily !== null || global.total !== null)) {
    const daily = global.daily,
      total = global.total;
    const row = (
      await tx.query<{ daily?: number; total?: number }>(
        daily !== null && total !== null
          ? `select count(*) filter(where created_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')::int as daily,
       count(*)::int as total from email_registration_rate_events where kind='recipient'`
          : daily !== null
            ? `select count(*)::int as daily from email_registration_rate_events where kind='recipient'
       and created_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'`
            : "select count(*)::int as total from email_registration_rate_events where kind='recipient'",
      )
    ).rows[0]!;
    if (
      (daily !== null && row.daily! >= daily) ||
      (total !== null && row.total! >= total)
    )
      throw new DomainError(
        429,
        "Общий лимит отправки писем исчерпан. Попробуйте позже",
      );
  }
  const limits = (
    await tx.query<{
      recipient_count: number;
      cooldown: boolean;
      ip_count: number;
    }>(
      `select count(*) filter(where kind='recipient' and key_hash=$1)::int as recipient_count,
       coalesce(bool_or(kind='recipient' and key_hash=$1 and created_at>clock_timestamp()-interval '60 seconds'),false) as cooldown,
       count(*) filter(where kind='ip' and key_hash=$2)::int as ip_count
       from email_registration_rate_events where created_at>clock_timestamp()-interval '1 hour'
       and ((kind='recipient' and key_hash=$1) or (kind='ip' and key_hash=$2))`,
      [recipientKey, ipKey],
    )
  ).rows[0]!;
  if (limits.recipient_count >= 3 || limits.cooldown || limits.ip_count >= 10)
    throw new DomainError(429, "Слишком много отправок. Попробуйте позже");
  await tx.query(
    "insert into email_registration_rate_events(kind,key_hash) values ('recipient',$1),('ip',$2)",
    [recipientKey, ipKey],
  );
}

export class PasswordRecovery {
  private readonly sendLimits?: Readonly<EmailSendLimits>;
  constructor(
    private db: Database,
    sendLimits?: EmailSendLimits,
  ) {
    if (sendLimits !== undefined) {
      if (
        sendLimits === null ||
        typeof sendLimits !== "object" ||
        Array.isArray(sendLimits)
      )
        throw new Error("Invalid email send admission limits");
      const snapshot = { daily: sendLimits.daily, total: sendLimits.total };
      if (
        ![snapshot.daily, snapshot.total].every(
          (value) =>
            value === null ||
            (Number.isSafeInteger(value) && value >= 0 && value <= 1000000),
        )
      )
        throw new Error("Invalid email send admission limits");
      this.sendLimits = Object.freeze(snapshot);
    }
  }

  async begin(raw: PasswordRecoveryBegin): Promise<PasswordRecoveryChallenge> {
    const input = parse(beginSchema, raw);
    if (input.email !== input.email.trim().toLowerCase()) throw invalid();
    return this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      if (
        (
          await tx.query(
            "select id from password_recovery_challenges where id=$1",
            [input.id],
          )
        ).rows.length
      )
        throw invalid();
      await quota(tx, input.recipientKey, input.ipKey, this.sendLimits);
      const user = (
        await tx.query<Eligible>(
          `select u.id::text,c.email,c.password_hash from users u
           join user_credentials c on c.user_id=u.id
           join account_email_verifications e on e.user_id=u.id and e.email=c.email
           where c.email=$1 and u.status='active' and c.email not like '%.invalid' for update of u`,
          [input.email],
        )
      ).rows[0];
      const result = (
        await tx.query<{ id: string; expiresAt: string }>(
          `insert into password_recovery_challenges(id,target_user_id,credential_digest,proof_hash,code_hash,recipient_key,expires_at)
           values ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')
           returning id::text,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
          [
            input.id,
            user?.id ?? null,
            user ? credentialDigest(user.password_hash) : null,
            input.proofHash,
            input.codeHash,
            input.recipientKey,
          ],
        )
      ).rows[0]!;
      return user ? { ...result, email: user.email } : result;
    });
  }

  async markSent(id: string, codeHash: string): Promise<void> {
    await this.delivery(id, codeHash, "sent");
  }
  async cancelDelivery(id: string, codeHash: string): Promise<void> {
    await this.delivery(id, codeHash, "failed");
  }
  private async delivery(
    id: string,
    codeHash: string,
    state: "sent" | "failed",
  ) {
    parse(idSchema, id);
    parse(digest, codeHash);
    // A single challenge-only CAS never waits for an account/security lock.
    // A delayed sender cannot mark a replacement, consumed or invalidated code.
    const changed = await this.db.query(
      `update password_recovery_challenges set delivery=$3
       where id=$1 and code_hash=$2 and delivery='pending'
       and consumed_at is null and invalidated_at is null and expires_at>clock_timestamp() returning id`,
      [id, codeHash, state],
    );
    if (changed.rows.length !== 1) throw invalid();
  }

  async resend(
    raw: PasswordRecoveryResend,
  ): Promise<PasswordRecoveryChallenge> {
    const input = parse(resendSchema, raw);
    return this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      const current = await pending(tx, input.id);
      if (
        !current ||
        current.consumed_at ||
        current.invalidated_at ||
        current.expired ||
        current.attempts >= 5 ||
        !equal(current.proof_hash, input.proofHash) ||
        equal(current.code_hash, input.codeHash)
      )
        throw invalid();
      await quota(tx, current.recipient_key, input.ipKey, this.sendLimits);
      // Lifetime and the cumulative five-guess budget are never reset by resend.
      await tx.query(
        "update password_recovery_challenges set code_hash=$2,delivery='pending' where id=$1",
        [input.id, input.codeHash],
      );
      const email = await deliveryEmail(tx, current);
      const result = { id: current.id, expiresAt: current.expiresAt };
      return email ? { ...result, email } : result;
    });
  }

  async confirm(raw: PasswordRecoveryConfirm): Promise<void> {
    const input = parse(confirmSchema, raw);
    const result = await this.db.transaction(async (tx) => {
      await lockSecurity(tx);
      const current = await pending(tx, input.id);
      if (
        !current ||
        current.consumed_at ||
        current.invalidated_at ||
        current.expired ||
        current.delivery !== "sent" ||
        current.attempts >= 5 ||
        !equal(current.proof_hash, input.proofHash)
      )
        return { error: invalid() };
      if (!equal(current.code_hash, input.codeHash)) {
        // Returning ensures the failed-guess increment commits before throwing.
        await tx.query(
          "update password_recovery_challenges set attempts=attempts+1 where id=$1",
          [input.id],
        );
        return { error: invalid() };
      }
      if (!(await deliveryEmail(tx, current))) return { error: invalid() };
      // Use one statement timestamp for the final expiry check and receipt.
      // If expiry crosses while eligibility is read, fail before any mutation
      // of credentials/sessions rather than raising a constraint error later.
      const consumed = await tx.query(
        `update password_recovery_challenges set consumed_at=statement_timestamp()
         where id=$1 and expires_at>statement_timestamp() returning id`,
        [input.id],
      );
      if (consumed.rows.length !== 1) return { error: invalid() };
      await tx.query(
        "update user_credentials set password_hash=$2 where user_id=$1",
        [current.target_user_id, input.newPasswordHash],
      );
      await tx.query(
        "update users set must_change_password=false,updated_at=clock_timestamp() where id=$1",
        [current.target_user_id],
      );
      await tx.query("delete from sessions where user_id=$1", [
        current.target_user_id,
      ]);
      await tx.query(
        `update password_recovery_challenges set invalidated_at=clock_timestamp()
        where target_user_id=$1 and id<>$2 and consumed_at is null and invalidated_at is null`,
        [current.target_user_id, input.id],
      );
      await tx.query(
        `insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)
        values ($1,'account-password-recovered','account',$2,'{"method":"email-code","sessionsRevoked":true}')`,
        [current.target_user_id, current.target_user_id],
      );
      return {};
    });
    if (result.error) throw result.error;
  }
}

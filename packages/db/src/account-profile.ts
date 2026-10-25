import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "./index.js";
import {
  consumeEmailSendQuota,
  type EmailSendLimits,
} from "./email-registration.js";
import { DomainError } from "./errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema = z.strictObject({
  userId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  sessionTokenHash: digest,
});
export type AccountProfileContext = z.infer<typeof contextSchema>;
const beginSchema = contextSchema.extend({
  id: z.uuid(),
  email: z.email().max(254),
  proofHash: digest,
  codeHash: digest,
  recipientKey: digest,
  ipKey: digest,
});
const resendSchema = contextSchema.extend({
  id: z.uuid(),
  proofHash: digest,
  codeHash: digest,
  ipKey: digest,
});
const confirmSchema = contextSchema.extend({
  id: z.uuid(),
  proofHash: digest,
  codeHash: digest,
});
type Current = {
  id: string;
  email: string;
  username: string | null;
  password_hash: string;
  emailVerified: boolean;
};
type Challenge = {
  id: string;
  user_id: string;
  email: string;
  credential_digest: string;
  session_token_hash: string;
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
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const emailOf = (u: Current) =>
  u.username === "admin" && u.email === "admin@citygo.invalid" ? null : u.email;
const invalid = () =>
  new DomainError(400, "Код подтверждения недействителен или истёк");
function parse<T>(schema: z.ZodType<T>, raw: unknown) {
  const value = schema.safeParse(raw);
  if (!value.success) throw invalid();
  return value.data;
}
async function authorize(
  tx: Sql,
  ctx: AccountProfileContext,
): Promise<Current> {
  if (
    (
      await tx.query(
        "select id from account_security_state where id=1 for update",
      )
    ).rows.length !== 1
  )
    throw new DomainError(503, "Хранилище аккаунтов не готово");
  await tx.query("select id from users where id=$1 for update", [ctx.userId]);
  const user = (
    await tx.query<Current & { must_change_password: boolean }>(
      `select u.id::text,c.email,u.username,c.password_hash,u.must_change_password,
     exists(select 1 from account_email_verifications e where e.user_id=u.id and e.email=c.email) as "emailVerified"
     from sessions s join users u on u.id=s.user_id join user_credentials c on c.user_id=u.id
     where s.user_id=$1 and s.token_hash=$2 and s.expires_at>clock_timestamp() and u.status='active' for update of s`,
      [ctx.userId, ctx.sessionTokenHash],
    )
  ).rows[0];
  if (!user) throw new DomainError(401, "Войдите в аккаунт");
  if (user.must_change_password)
    throw new DomainError(403, "Сначала смените временный пароль");
  return user;
}
async function pending(tx: Sql, ctx: AccountProfileContext, id: string) {
  return (
    await tx.query<Challenge>(
      `select id::text,user_id::text,email,credential_digest,session_token_hash,proof_hash,code_hash,recipient_key,delivery,attempts,
     to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
     expires_at<=clock_timestamp() as expired,consumed_at,invalidated_at
     from account_email_confirmation_challenges where id=$1 and user_id=$2 for update`,
      [id, ctx.userId],
    )
  ).rows[0];
}
function valid(
  current: Challenge | undefined,
  user: Current,
  ctx: AccountProfileContext,
  proofHash: string,
): current is Challenge {
  return (
    !!current &&
    !current.consumed_at &&
    !current.invalidated_at &&
    !current.expired &&
    current.attempts < 5 &&
    current.email === user.email &&
    equal(current.credential_digest, hash(user.password_hash)) &&
    equal(current.session_token_hash, ctx.sessionTokenHash) &&
    equal(current.proof_hash, proofHash)
  );
}

/** Existing-account evidence only. No provider/SMTP calls or raw codes in storage. */
export class AccountProfile {
  private readonly limits?: Readonly<EmailSendLimits>;
  constructor(
    private db: Database,
    limits?: EmailSendLimits,
  ) {
    if (limits !== undefined) {
      if (!limits || typeof limits !== "object" || Array.isArray(limits))
        throw new Error("Invalid email send admission limits");
      const copy = { daily: limits.daily, total: limits.total };
      if (
        !Object.values(copy).every(
          (v) =>
            v === null || (Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000),
        )
      )
        throw new Error("Invalid email send admission limits");
      this.limits = Object.freeze(copy);
    }
  }
  async summary(raw: AccountProfileContext) {
    const ctx = parse(contextSchema, raw);
    return this.db.transaction(async (tx) => {
      const user = await authorize(tx, ctx);
      const row = (
        await tx.query<{ phoneVerified: boolean; giftClaimed: boolean }>(
          `select exists(select 1 from phone_welcome_claims w
          join phone_verification_challenges c on c.id=w.challenge_id and c.user_id=w.user_id and c.phone_key=w.phone_key
          join ai_credit_entries e on e.operation_id=w.operation_id and e.user_id=w.user_id and e.kind='bonus' and e.amount_micros=w.granted_micros
          join phone_verification_control p on p.id=1 and p.bound_at is not null and p.policy_fingerprint=c.policy_fingerprint
          where w.user_id=$1 and c.consumed_at is not null and c.consumed_operation_id=w.operation_id
            and c.delivery='accepted' and c.superseded_at is null) as "phoneVerified",
         (exists(select 1 from phone_welcome_claims where user_id=$1)
          or exists(select 1 from ai_credit_entries where user_id=$1 and kind='bonus')) as "giftClaimed"`,
          [ctx.userId],
        )
      ).rows[0]!;
      const email = emailOf(user);
      return {
        userId: user.id,
        email,
        emailVerified: email !== null && user.emailVerified,
        ...row,
      };
    });
  }
  async begin(raw: z.infer<typeof beginSchema>) {
    const input = parse(beginSchema, raw);
    return this.db.transaction(async (tx) => {
      const user = await authorize(tx, input);
      if (!emailOf(user) || user.email !== input.email) throw invalid();
      if (user.emailVerified)
        throw new DomainError(409, "Почта уже подтверждена");
      await consumeEmailSendQuota(
        tx,
        input.recipientKey,
        input.ipKey,
        this.limits,
      );
      await tx.query(
        `update account_email_confirmation_challenges set invalidated_at=clock_timestamp()
        where user_id=$1 and consumed_at is null and invalidated_at is null`,
        [input.userId],
      );
      return (
        await tx.query<{ id: string; email: string; expiresAt: string }>(
          `insert into account_email_confirmation_challenges(id,user_id,email,credential_digest,session_token_hash,proof_hash,code_hash,recipient_key,expires_at)
         values($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes')
         returning id::text,email,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
          [
            input.id,
            input.userId,
            user.email,
            hash(user.password_hash),
            input.sessionTokenHash,
            input.proofHash,
            input.codeHash,
            input.recipientKey,
          ],
        )
      ).rows[0]!;
    });
  }
  async resend(raw: z.infer<typeof resendSchema>) {
    const input = parse(resendSchema, raw);
    return this.db.transaction(async (tx) => {
      const user = await authorize(tx, input),
        current = await pending(tx, input, input.id);
      if (
        user.emailVerified ||
        !valid(current, user, input, input.proofHash) ||
        equal(current.code_hash, input.codeHash)
      )
        throw invalid();
      await consumeEmailSendQuota(
        tx,
        current.recipient_key,
        input.ipKey,
        this.limits,
      );
      await tx.query(
        "update account_email_confirmation_challenges set code_hash=$2,delivery='pending' where id=$1",
        [input.id, input.codeHash],
      );
      return {
        id: current.id,
        email: current.email,
        expiresAt: current.expiresAt,
      };
    });
  }
  async markSent(id: string, codeHash: string) {
    await this.delivery(id, codeHash, "sent");
  }
  async cancelDelivery(id: string, codeHash: string) {
    await this.delivery(id, codeHash, "failed");
  }
  private async delivery(
    id: string,
    codeHash: string,
    delivery: "sent" | "failed",
  ) {
    parse(z.uuid(), id);
    parse(digest, codeHash);
    const changed = await this.db.query(
      `update account_email_confirmation_challenges set delivery=$3
      where id=$1 and code_hash=$2 and delivery='pending' and consumed_at is null and invalidated_at is null
      and expires_at>clock_timestamp() returning id`,
      [id, codeHash, delivery],
    );
    if (changed.rows.length !== 1) throw invalid();
  }
  async confirm(raw: z.infer<typeof confirmSchema>) {
    const input = parse(confirmSchema, raw);
    const result = await this.db.transaction(async (tx) => {
      const user = await authorize(tx, input),
        current = await pending(tx, input, input.id);
      if (
        user.emailVerified ||
        !valid(current, user, input, input.proofHash) ||
        current.delivery !== "sent"
      )
        return { error: invalid() };
      if (!equal(current.code_hash, input.codeHash)) {
        await tx.query(
          "update account_email_confirmation_challenges set attempts=attempts+1 where id=$1",
          [input.id],
        );
        return { error: invalid() };
      }
      const consumed = await tx.query(
        `update account_email_confirmation_challenges set consumed_at=statement_timestamp()
        where id=$1 and expires_at>statement_timestamp() returning id`,
        [input.id],
      );
      if (consumed.rows.length !== 1) return { error: invalid() };
      await tx.query(
        "insert into account_email_verifications(user_id,confirmation_id,email) values($1,$2,$3)",
        [user.id, current.id, user.email],
      );
      await tx.query(
        `update account_email_confirmation_challenges set invalidated_at=clock_timestamp()
        where user_id=$1 and id<>$2 and consumed_at is null and invalidated_at is null`,
        [user.id, current.id],
      );
      await tx.query(
        `insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)
        values($1,'account-email-verified','account',$3,$2::jsonb)`,
        [
          user.id,
          JSON.stringify({
            method: "account-email-code",
            confirmationId: current.id,
          }),
          user.id,
        ],
      );
      return { userId: user.id, emailVerified: true as const };
    });
    if (result.error) throw result.error;
    return { userId: result.userId!, emailVerified: true as const };
  }
}

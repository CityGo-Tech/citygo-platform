import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  serviceConsentChoiceSchema,
  type ServiceConsentChoice,
  type ServiceConsentPolicy,
} from "@citygo/contracts";
import {
  consentPolicyHash,
  recordServiceConsent,
  validateServiceConsent,
} from "./service-consents.js";
import {
  readServiceConsentContext,
  type ServiceAiPolicyResolver,
} from "./service-consent-context.js";
import type { Database, Sql } from "./index.js";
import type { AccountInfo } from "./account-access.js";
import { DomainError } from "./errors.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.uuid();
const beginSchema = z.strictObject({
  id: idSchema,
  email: z.email().max(254),
  passwordHash: z.string().min(1).max(2048),
  proofHash: digest,
  codeHash: digest,
  recipientKey: digest,
  ipKey: digest,
  consents: serviceConsentChoiceSchema,
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
  sessionHash: digest,
});
export type EmailRegistrationBegin = z.infer<typeof beginSchema>;
export type EmailRegistrationResend = z.infer<typeof resendSchema>;
export type EmailRegistrationConfirm = z.infer<typeof confirmSchema>;
type PendingRegistration = {
  id: string;
  email: string;
  password_hash: string;
  proof_hash: string;
  code_hash: string;
  recipient_key: string;
  delivery: "pending" | "sent" | "failed";
  attempts: number;
  expiresAt: string;
  expired: boolean;
  consumed_user_id: string | null;
  consent_choice: ServiceConsentChoice | null;
  consent_policy: ServiceConsentPolicy | null;
  consent_policy_hash: string | null;
  consent_recorded_at: string | null;
};

function invalid() {
  return new DomainError(400, "Код подтверждения недействителен или истёк");
}
function hasCurrentConsent(
  current: PendingRegistration | undefined,
  policy: ServiceConsentPolicy,
) {
  if (
    !current?.consent_choice ||
    !current.consent_policy ||
    !current.consent_recorded_at ||
    current.consent_choice.policyVersion !== current.consent_policy.version ||
    consentPolicyHash(current.consent_policy) !== current.consent_policy_hash
  )
    return false;
  if (
    current.consent_choice.policyVersion !== policy.version ||
    current.consent_policy_hash !== consentPolicyHash(policy)
  )
    throw new DomainError(
      409,
      "Условия изменились. Начните регистрацию заново и подтвердите новый текст согласия.",
      "SERVICE_CONSENT_POLICY_CHANGED",
    );
  return true;
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
async function pending(tx: Sql, id: string) {
  return (
    await tx.query<PendingRegistration>(
      `select id::text,email,password_hash,proof_hash,code_hash,recipient_key,delivery,attempts,
       to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
       expires_at<=clock_timestamp() as expired,consumed_user_id::text,
       consent_choice,consent_policy,consent_policy_hash,
       consent_recorded_at::text
       from email_registrations where id=$1 for update`,
      [id],
    )
  ).rows[0];
}
async function accountExists(tx: Sql, email: string) {
  return (
    (
      await tx.query("select user_id from user_credentials where email=$1", [
        email,
      ])
    ).rows.length > 0
  );
}
// null is explicit unlimited admission for this field; numeric zero still denies.
// An omitted object preserves the historical recipient/IP-only configuration.
export type EmailSendLimits = { daily: number | null; total: number | null };
export async function consumeEmailSendQuota(
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
      `select
       count(*) filter(where kind='recipient' and key_hash=$1)::int as recipient_count,
       coalesce(bool_or(kind='recipient' and key_hash=$1 and created_at>clock_timestamp()-interval '60 seconds'),false) as cooldown,
       count(*) filter(where kind='ip' and key_hash=$2)::int as ip_count
       from email_registration_rate_events
       where created_at>clock_timestamp()-interval '1 hour'
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

// Server-owned pending-registration state machine. The caller computes HMACs,
// hashes passwords and performs delivery OUTSIDE these short transactions.
// No SMTP, user-visible OTP, bonus, provider request or runtime activation here.
export class EmailRegistration {
  private readonly sendLimits?: Readonly<EmailSendLimits>;
  constructor(
    private db: Database,
    sendLimits?: EmailSendLimits,
    private resolveAiPolicy?: ServiceAiPolicyResolver,
  ) {
    if (sendLimits !== undefined) {
      if (
        sendLimits === null ||
        typeof sendLimits !== "object" ||
        Array.isArray(sendLimits)
      )
        throw new Error("Invalid email send admission limits");
      // Read each field once and validate the frozen snapshot, not the caller's
      // mutable object. Undefined fields are not another spelling of unlimited.
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

  async begin(raw: EmailRegistrationBegin) {
    const input = parse(beginSchema, raw);
    if (input.email !== input.email.trim().toLowerCase()) throw invalid();
    return this.db.transaction(async (tx) => {
      const context = await readServiceConsentContext(tx, this.resolveAiPolicy);
      validateServiceConsent(input.consents, context.policy);
      await lockSecurity(tx);
      if (await accountExists(tx, input.email))
        throw new DomainError(409, "Аккаунт с этой почтой уже существует");
      if (
        (
          await tx.query("select id from email_registrations where id=$1", [
            input.id,
          ])
        ).rows.length
      )
        throw new DomainError(409, "Попытка регистрации уже существует");
      await consumeEmailSendQuota(
        tx,
        input.recipientKey,
        input.ipKey,
        this.sendLimits,
      );
      return (
        await tx.query<{ id: string; expiresAt: string }>(
          `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,expires_at,consent_choice,consent_policy,consent_policy_hash,consent_recorded_at)
           values ($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes',$7::jsonb,$8::jsonb,$9,clock_timestamp())
           returning id::text,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
          [
            input.id,
            input.email,
            input.passwordHash,
            input.proofHash,
            input.codeHash,
            input.recipientKey,
            JSON.stringify(input.consents),
            JSON.stringify(context.policy),
            consentPolicyHash(context.policy),
          ],
        )
      ).rows[0]!;
    });
  }

  // A delayed old sender response cannot alter the state of a replacement code.
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
    const changed = await this.db.query(
      `update email_registrations set delivery=$3
       where id=$1 and code_hash=$2 and delivery='pending'
         and consumed_user_id is null and expires_at>clock_timestamp() returning id`,
      [id, codeHash, state],
    );
    if (changed.rows.length !== 1) throw invalid();
  }

  async resend(raw: EmailRegistrationResend) {
    const input = parse(resendSchema, raw);
    return this.db.transaction(async (tx) => {
      const context = await readServiceConsentContext(tx, this.resolveAiPolicy);
      await lockSecurity(tx);
      const current = await pending(tx, input.id);
      if (
        !current ||
        current.consumed_user_id ||
        !hasCurrentConsent(current, context.policy) ||
        !equal(current.proof_hash, input.proofHash) ||
        equal(current.code_hash, input.codeHash)
      )
        throw invalid();
      if (await accountExists(tx, current.email))
        throw new DomainError(409, "Аккаунт с этой почтой уже существует");
      await consumeEmailSendQuota(
        tx,
        current.recipient_key,
        input.ipKey,
        this.sendLimits,
      );
      const next = (
        await tx.query<{ expiresAt: string }>(
          `update email_registrations set code_hash=$2,delivery='pending',attempts=0,
           expires_at=clock_timestamp()+interval '10 minutes' where id=$1
           returning to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt"`,
          [input.id, input.codeHash],
        )
      ).rows[0]!;
      return { email: current.email, expiresAt: next.expiresAt };
    });
  }

  async confirm(raw: EmailRegistrationConfirm): Promise<AccountInfo> {
    const input = parse(confirmSchema, raw);
    const result = await this.db.transaction(async (tx) => {
      const context = await readServiceConsentContext(tx, this.resolveAiPolicy);
      await lockSecurity(tx);
      const current = await pending(tx, input.id);
      if (
        !current ||
        current.consumed_user_id ||
        !hasCurrentConsent(current, context.policy) ||
        current.expired ||
        current.delivery !== "sent" ||
        current.attempts >= 5 ||
        !equal(current.proof_hash, input.proofHash)
      )
        return { error: invalid() };
      if (!equal(current.code_hash, input.codeHash)) {
        // Return, do not throw: incorrect attempts MUST commit to stop guessing.
        await tx.query(
          "update email_registrations set attempts=attempts+1 where id=$1",
          [input.id],
        );
        return { error: invalid() };
      }
      if (await accountExists(tx, current.email))
        return {
          error: new DomainError(409, "Аккаунт с этой почтой уже существует"),
        };
      const user = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject) values ($1) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,$2,$3)",
        [user.id, current.email, current.password_hash],
      );
      await recordServiceConsent(
        tx,
        {
          userId: user.id,
          email: current.email,
          choice: current.consent_choice!,
          source: "email-registration",
          registrationId: input.id,
          choiceRecordedAt: current.consent_recorded_at!,
        },
        context,
      );
      await tx.query(
        "update email_registrations set consumed_user_id=$2,consumed_at=clock_timestamp() where id=$1",
        [input.id, user.id],
      );
      await tx.query(
        "insert into account_email_verifications(user_id,registration_id,email) values ($1,$2,$3)",
        [user.id, input.id, current.email],
      );
      await tx.query(
        "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,clock_timestamp()+interval '7 days')",
        [input.sessionHash, user.id],
      );
      await tx.query(
        "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload) values ($1,'account-email-verified','account',$2,'{\"method\":\"registration-code\"}')",
        [user.id, user.id],
      );
      return {
        user: {
          id: user.id,
          email: current.email,
          username: null,
          role: "user" as const,
          mustChangePassword: false,
          serviceConsentRequired: false,
        },
      };
    });
    if (result.error) throw result.error;
    return result.user!;
  }
}

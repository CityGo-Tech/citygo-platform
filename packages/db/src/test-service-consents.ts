// Synthetic choices for isolated fixtures only. Production never imports this.
import {
  serviceConsentPolicy,
  type ServiceConsentChoice,
} from "@citygo/contracts";
import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "./index.js";
import { readFile } from "node:fs/promises";
import {
  consentPolicyHash,
  readServiceConsentContext,
  type ServiceAiPolicyResolver,
  type ServiceConsentContext,
} from "./service-consent-context.js";
export const syntheticServiceConsents = {
  policyVersion: serviceConsentPolicy.version,
  personalData: true as const,
  marketing: false,
};
export async function applyFixtureMigration(db: Database, name: string) {
  if (!/^\d{4}_[a-z_]+\.sql$/.test(name))
    throw new Error("Invalid fixture migration");
  const source = await readFile(
    new URL("../migrations/" + name, import.meta.url),
    "utf8",
  );
  const checksum = createHash("sha256")
    .update(source.replaceAll("\r\n", "\n"))
    .digest("hex");
  await db.transaction(async (tx) => {
    const applied = (
      await tx.query<{ checksum: string }>(
        "select checksum from citygo_migrations where name=$1",
        [name],
      )
    ).rows[0];
    if (applied) {
      if (applied.checksum !== checksum)
        throw new Error("Changed historical fixture migration");
      return;
    }
    await tx.exec(
      source.replace(/^begin;\s*/i, "").replace(/commit;\s*$/i, ""),
    );
    await tx.query(
      "insert into citygo_migrations(name,checksum) values($1,$2)",
      [name, checksum],
    );
  });
}

// Historical schema26–29 fixtures predate explicit service consent. Seed their
// actual old email-verification evidence without calling the new signup API or
// manufacturing a consent grant. The schema30 upgrade must leave them gated.
export async function seedLegacyVerifiedEmail(db: Database, email: string) {
  const digest = createHash("sha256").update(email).digest("hex"),
    id = randomUUID();
  return db.transaction(async (tx) => {
    const user = (
      await tx.query<{ id: string }>(
        "insert into users(auth_subject) values($1) returning id::text",
        [randomUUID()],
      )
    ).rows[0]!;
    await tx.query(
      "insert into user_credentials(user_id,email,password_hash) values($1,$2,'synthetic-historical-hash')",
      [user.id, email],
    );
    await tx.query(
      `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,delivery,expires_at,consumed_user_id,consumed_at)
      values($1,$2,'synthetic-historical-hash',$3,$3,$3,'sent',clock_timestamp()+interval '10 minutes',$4,clock_timestamp())`,
      [id, email, digest, user.id],
    );
    await tx.query(
      "insert into account_email_verifications(user_id,registration_id,email) values($1,$2,$3)",
      [user.id, id, email],
    );
    await tx.query(
      "insert into sessions(token_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '7 days')",
      [digest, user.id],
    );
    return user;
  });
}

// These explicit historical SQL seeds reproduce schema30–49 creation. They
// never call a current registrator or suppress a missing current-schema table.
// Latest-schema tests must keep exercising EmailRegistration/ServiceConsents.
async function requirePre50ConsentSchema(tx: Sql) {
  const state = (
    await tx.query<{ allowed: boolean }>(
      `select to_regclass('service_consent_events') is not null
       and to_regclass('user_acquisition') is null
       and not exists(select 1 from information_schema.columns where table_schema='public'
         and table_name='email_registrations' and column_name='landing_attribution') as allowed`,
    )
  ).rows[0];
  if (!state?.allowed) throw new Error("Historical seed requires schema30–49");
}

async function seedPre50ConsentEvidence(
  tx: Sql,
  userId: string,
  email: string,
  choice: ServiceConsentChoice,
  context: ServiceConsentContext,
  registrationId?: string,
  recordedAt?: string,
) {
  if (!choice.personalData || choice.policyVersion !== context.policy.version)
    throw new Error("Historical fixture needs its exact explicit consent");
  for (const [purpose, decision] of [
    ["personal-data", "granted"],
    ["marketing", choice.marketing ? "granted" : "declined"],
  ])
    await tx.query(
      `insert into service_consent_events(user_id,subject_email,registration_id,policy_version,policy_snapshot,policy_hash,purpose,decision,source,choice_recorded_at)
       values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,coalesce($10::timestamptz,clock_timestamp()))`,
      [
        userId,
        email,
        registrationId ?? null,
        choice.policyVersion,
        JSON.stringify(context.policy),
        consentPolicyHash(context.policy),
        purpose,
        decision,
        registrationId ? "email-registration" : "signup",
        recordedAt ?? null,
      ],
    );
  if (context.aiPolicy) {
    await tx.query(
      "insert into ai_consents(user_id,policy_id,granted)values($1,$2,true)",
      [userId, context.aiPolicy.id],
    );
    await tx.query(
      "insert into consent_events(user_id,consent_key,action,policy_version,details)values($1,'ai-recipient','granted',$2,$3::jsonb)",
      [userId, context.aiPolicy.id, JSON.stringify(context.aiPolicy)],
    );
  }
}

export async function seedPre50ConsentedAccount(
  db: Database,
  email: string,
  passwordHash: string,
  sessionHash: string,
  choice: ServiceConsentChoice,
  resolver?: ServiceAiPolicyResolver,
) {
  return db.transaction(async (tx) => {
    await requirePre50ConsentSchema(tx);
    const context = await readServiceConsentContext(tx, resolver);
    const user = (
      await tx.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [randomUUID()],
      )
    ).rows[0]!;
    await tx.query(
      "insert into user_credentials(user_id,email,password_hash)values($1,$2,$3)",
      [user.id, email, passwordHash],
    );
    await seedPre50ConsentEvidence(tx, user.id, email, choice, context);
    await tx.query(
      "insert into sessions(token_hash,user_id,expires_at)values($1,$2,clock_timestamp()+interval '7 days')",
      [sessionHash, user.id],
    );
    return user;
  });
}

export async function seedPre50EmailRegistration(
  db: Database,
  input: {
    id: string;
    email: string;
    passwordHash: string;
    proofHash: string;
    codeHash: string;
    recipientKey: string;
    ipKey: string;
    consents: ServiceConsentChoice;
  },
  sessionHash: string,
) {
  return db.transaction(async (tx) => {
    await requirePre50ConsentSchema(tx);
    const context = await readServiceConsentContext(tx);
    const user = (
      await tx.query<{ id: string }>(
        "insert into users(auth_subject)values($1)returning id::text",
        [randomUUID()],
      )
    ).rows[0]!;
    await tx.query(
      "insert into user_credentials(user_id,email,password_hash)values($1,$2,$3)",
      [user.id, input.email, input.passwordHash],
    );
    await tx.query(
      "insert into email_registration_rate_events(kind,key_hash)values('recipient',$1),('ip',$2)",
      [input.recipientKey, input.ipKey],
    );
    const pending = (
      await tx.query<{ recorded_at: string }>(
        `insert into email_registrations(id,email,password_hash,proof_hash,code_hash,recipient_key,delivery,expires_at,consent_choice,consent_policy,consent_policy_hash,consent_recorded_at)
       values($1,$2,$3,$4,$5,$6,'sent',clock_timestamp()+interval '10 minutes',$7::jsonb,$8::jsonb,$9,clock_timestamp())
       returning consent_recorded_at::text as recorded_at`,
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
    await seedPre50ConsentEvidence(
      tx,
      user.id,
      input.email,
      input.consents,
      context,
      input.id,
      pending.recorded_at,
    );
    await tx.query(
      "update email_registrations set consumed_user_id=$2,consumed_at=clock_timestamp()where id=$1",
      [input.id, user.id],
    );
    await tx.query(
      "insert into account_email_verifications(user_id,registration_id,email)values($1,$2,$3)",
      [user.id, input.id, input.email],
    );
    await tx.query(
      "insert into sessions(token_hash,user_id,expires_at)values($1,$2,clock_timestamp()+interval '7 days')",
      [sessionHash, user.id],
    );
    await tx.query(
      "insert into audit_log(actor_user_id,action,entity_type,entity_id,payload)values($1,'account-email-verified','account',$2,'{\"method\":\"registration-code\"}')",
      [user.id, user.id],
    );
    return user;
  });
}

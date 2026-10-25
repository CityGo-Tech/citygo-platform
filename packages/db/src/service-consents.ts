import { createHash, randomUUID } from "node:crypto";
import {
  serviceConsentChoiceSchema,
  serviceConsentPolicy,
  type ServiceConsentChoice,
  type ServiceConsentPolicy,
  type ServiceConsentState,
} from "@citygo/contracts";
import type { Database, Sql } from "./index.js";
import { DomainError } from "./errors.js";

// JSONB may reorder keys; sort recursively so the digest survives SQL storage.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const consentPolicyHash = (policy: ServiceConsentPolicy) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(policy)))
    .digest("hex");
export function validateServiceConsent(raw: unknown): ServiceConsentChoice {
  const choice = serviceConsentChoiceSchema.safeParse(raw);
  if (!choice.success)
    throw new DomainError(
      400,
      "Для регистрации необходимо явное согласие на обработку персональных данных",
    );
  if (choice.data.policyVersion !== serviceConsentPolicy.version)
    throw new DomainError(
      409,
      "Текст согласия изменился. Ознакомьтесь с текущей версией и подтвердите выбор заново.",
      "SERVICE_CONSENT_POLICY_CHANGED",
    );
  return choice.data;
}

async function state(tx: Sql, userId: string): Promise<ServiceConsentState> {
  const latest = (
    await tx.query<{ purpose: string; decision: string }>(
      `select distinct on (purpose) purpose,decision from service_consent_events
     where user_id=$1 and policy_version=$2 and policy_hash=$3 order by purpose,id desc`,
      [
        userId,
        serviceConsentPolicy.version,
        consentPolicyHash(serviceConsentPolicy),
      ],
    )
  ).rows;
  const personalDataGranted = latest.some(
    (row) => row.purpose === "personal-data" && row.decision === "granted",
  );
  const marketingGranted = latest.some(
    (row) => row.purpose === "marketing" && row.decision === "granted",
  );
  return {
    policy: serviceConsentPolicy,
    personalDataGranted,
    marketingGranted,
    serviceConsentRequired: !personalDataGranted,
  };
}

// Called inside the transaction which creates/locks the account. Email choices
// are captured before delivery and copied unchanged when the OTP is consumed.
export async function recordServiceConsent(
  tx: Sql,
  input: {
    userId: string;
    email: string;
    choice: ServiceConsentChoice;
    source: "signup" | "email-registration" | "existing-account";
    registrationId?: string;
    choiceRecordedAt?: string;
  },
) {
  const choice = validateServiceConsent(input.choice);
  const previous = await state(tx, input.userId);
  const priorMarketing = (
    await tx.query<{ decision: string }>(
      `select decision from service_consent_events where user_id=$1 and policy_version=$2
     and policy_hash=$3 and purpose='marketing' order by id desc limit 1`,
      [
        input.userId,
        choice.policyVersion,
        consentPolicyHash(serviceConsentPolicy),
      ],
    )
  ).rows[0];
  const decisions: [string, string][] = [];
  if (!previous.personalDataGranted)
    decisions.push(["personal-data", "granted"]);
  if (!priorMarketing || previous.marketingGranted !== choice.marketing)
    decisions.push([
      "marketing",
      choice.marketing
        ? "granted"
        : previous.marketingGranted
          ? "withdrawn"
          : "declined",
    ]);
  for (const [purpose, decision] of decisions)
    await tx.query(
      `insert into service_consent_events(user_id,subject_email,registration_id,policy_version,policy_snapshot,policy_hash,purpose,decision,source,choice_recorded_at)
       values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,coalesce($10::timestamptz,clock_timestamp()))`,
      [
        input.userId,
        input.email,
        input.registrationId ?? null,
        choice.policyVersion,
        JSON.stringify(serviceConsentPolicy),
        consentPolicyHash(serviceConsentPolicy),
        purpose,
        decision,
        input.source,
        input.choiceRecordedAt ?? null,
      ],
    );
  return state(tx, input.userId);
}

export class ServiceConsents {
  constructor(private db: Database) {}
  async state(userId: string) {
    return state(this.db, userId);
  }
  async choose(userId: string, raw: unknown) {
    const choice = validateServiceConsent(raw);
    return this.db.transaction(async (tx) => {
      const user = (
        await tx.query<{ email: string }>(
          `select c.email from users u join user_credentials c on c.user_id=u.id
         where u.id=$1 and u.status='active' for update of u`,
          [userId],
        )
      ).rows[0];
      if (!user) throw new DomainError(401, "Войдите в аккаунт");
      return recordServiceConsent(tx, {
        userId,
        email: user.email,
        choice,
        source: "existing-account",
      });
    });
  }
  // Legacy email/password signup still requires the same explicit choices.
  // Account, consent evidence and initial session commit or roll back together.
  async register(
    email: string,
    passwordHash: string,
    sessionHash: string,
    raw: unknown,
  ) {
    const choice = validateServiceConsent(raw);
    return this.db.transaction(async (tx) => {
      await tx.query(
        "select id from account_security_state where id=1 for update",
      );
      if (
        (
          await tx.query(
            "select user_id from user_credentials where email=$1",
            [email],
          )
        ).rows.length
      )
        throw new DomainError(409, "Аккаунт с этой почтой уже существует");
      const user = (
        await tx.query<{ id: string }>(
          "insert into users(auth_subject) values ($1) returning id::text",
          [randomUUID()],
        )
      ).rows[0]!;
      await tx.query(
        "insert into user_credentials(user_id,email,password_hash) values ($1,$2,$3)",
        [user.id, email, passwordHash],
      );
      await recordServiceConsent(tx, {
        userId: user.id,
        email,
        choice,
        source: "signup",
      });
      await tx.query(
        "insert into sessions(token_hash,user_id,expires_at) values ($1,$2,clock_timestamp()+interval '7 days')",
        [sessionHash, user.id],
      );
      return {
        id: user.id,
        email,
        username: null,
        role: "user" as const,
        mustChangePassword: false,
        serviceConsentRequired: false,
      };
    });
  }
}
